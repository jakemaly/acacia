"""Build one reusable Modal VM image for a frozen Acacia source release."""

import hashlib
import io
import re
import tarfile
from pathlib import Path

BOT_IMAGE = "minecraft-mine-ai:acacia-fork-compat"
SERVER_IMAGE = "eclipse-temurin:21-jre@sha256:a80c51f2d09a3e7e00d521f1c817bbceb6b3be94109b4a784d46078099882dda"
DOCKER_IMAGE = "docker:28-dind"
BUILD_FILES = (
    "Dockerfile", "inside.mjs", "viewer.mjs", "recording.mjs",
    "browser-recording.mjs", "viewer.patch", "viewer-package.json", "viewer-package-lock.json",
)


def build_context(source, commit):
    """Create the same bot build context as build-bot-image.sh from a frozen release."""
    source = Path(source)
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Invalid release commit")
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w") as archive:
        for filename in BUILD_FILES:
            archive.add(source / "deploy" / filename, arcname=f"deploy/{filename}", recursive=False)
        archive.add(source / "mine-ai-mcp", arcname="deploy/mine-ai-source")
        text = (commit + "\n").encode()
        entry = tarfile.TarInfo("deploy/mine-ai-source.commit")
        entry.size = len(text)
        entry.mode = 0o644
        archive.addfile(entry, io.BytesIO(text))
    context = data.getvalue()
    return context, hashlib.sha256(context).hexdigest()


def runtime_context(source):
    data = io.BytesIO()
    source = Path(source)
    with tarfile.open(fileobj=data, mode="w") as archive:
        for name in ("src", "deploy", "web", "fixtures", "package.json", "package-lock.json"):
            path = source / name
            if path.exists():
                archive.add(path, arcname=name)
    return data.getvalue()


def _exec(sandbox, *command, timeout=60):
    proc = sandbox.exec(*command, timeout=timeout)
    proc.wait()
    stdout, stderr = proc.stdout.read(), proc.stderr.read()
    if proc.returncode != 0:
        raise RuntimeError(f"{command[0]} failed: {stderr[-4000:] or stdout[-4000:]}")
    return stdout


def build_release(app, source, commit, working_tree, digest, base_image_id=None):
    """Build and snapshot Docker after a clean daemon shutdown; never save credentials."""
    import modal

    if working_tree not in ("clean", "dirty") or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("Invalid release provenance")
    context, context_digest = build_context(source, commit)
    runtime = runtime_context(source)
    image = modal.Image.from_id(base_image_id) if base_image_id else modal.Image.from_registry(DOCKER_IMAGE)
    sandbox = modal.Sandbox.create(
        "sh", "-c", "dockerd >/tmp/dockerd.log 2>&1 & wait $!; exec sleep 86400",
        app=app, image=image, runtime="vm", timeout=1800, cpu=2, memory=4096,
        readiness_probe=modal.Probe.with_exec("docker", "info", interval_ms=500),
    )
    try:
        sandbox.wait_until_ready(timeout=120)
        sandbox.filesystem.write_bytes(context, "/tmp/acacia-context.tar")
        _exec(sandbox, "mkdir", "-p", "/tmp/acacia-context")
        _exec(sandbox, "tar", "-xf", "/tmp/acacia-context.tar", "-C", "/tmp/acacia-context")
        _exec(sandbox, "docker", "build", "--quiet", "--file", "/tmp/acacia-context/deploy/Dockerfile",
              "--build-arg", f"MINE_AI_FORK_REPOSITORY=https://github.com/jakemaly/acacia",
              "--build-arg", f"MINE_AI_FORK_COMMIT={commit}",
              "--build-arg", f"MINE_AI_FORK_WORKING_TREE={working_tree}",
              "--build-arg", f"ACACIA_SOURCE_COMMIT={commit}",
              "--build-arg", f"ACACIA_SOURCE_WORKING_TREE={working_tree}",
              "--build-arg", f"ACACIA_SOURCE_DIGEST={digest}",
              "--tag", BOT_IMAGE, "/tmp/acacia-context", timeout=1200)
        _exec(sandbox, "docker", "pull", SERVER_IMAGE, timeout=300)
        bot_id = _exec(sandbox, "docker", "image", "inspect", "--format", "{{.Id}}", BOT_IMAGE).strip()
        sandbox.filesystem.write_bytes(runtime, "/tmp/acacia-runtime.tar")
        _exec(sandbox, "rm", "-rf", "/opt/acacia")
        _exec(sandbox, "mkdir", "-p", "/opt/acacia")
        _exec(sandbox, "tar", "-xf", "/tmp/acacia-runtime.tar", "-C", "/opt/acacia")
        _exec(sandbox, "docker", "pull", "node:24-alpine", timeout=300)
        _exec(sandbox, "docker", "run", "--rm", "-v", "/opt/acacia:/app", "-w", "/app",
              "node:24-alpine", "npm", "ci", "--omit=dev", timeout=300)
        container = _exec(sandbox, "docker", "create", "node:24-alpine").strip()
        try:
            _exec(sandbox, "docker", "cp", f"{container}:/usr/local/bin/node", "/usr/local/bin/node")
        finally:
            _exec(sandbox, "docker", "rm", container)
        _exec(sandbox, "apk", "add", "--no-cache", "libstdc++", timeout=120)
        _exec(sandbox, "node", "--version")
        _exec(sandbox, "rm", "-rf", "/tmp/acacia-context", "/tmp/acacia-context.tar", "/tmp/acacia-runtime.tar")
        # The image snapshot must not contain Docker's in-flight database writes.
        _exec(sandbox, "sh", "-c", "killall -TERM dockerd; while killall -0 dockerd 2>/dev/null; do sleep 1; done; sync", timeout=60)
        snapshot = sandbox.snapshot_filesystem(timeout=180)
        return {"imageId": snapshot.object_id, "botImageId": bot_id, "sourceDigest": digest,
                "contextDigest": context_digest, "commit": commit, "workingTree": working_tree}
    finally:
        sandbox.terminate(wait=True)
