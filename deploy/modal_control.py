"""Small local bridge to Modal. Requests and responses are JSON on stdin/stdout."""

import json
import io
import os
import re
import sys
import tarfile
from datetime import datetime, timedelta, timezone

APP_NAME = os.environ.get("ACACIA_MODAL_APP", "acacia")
VOLUME_NAME = os.environ.get("ACACIA_MODAL_VOLUME", "acacia-runs-v2")
BOOT = "export DOCKER_HOST=unix:///var/run/docker.sock; dockerd >/tmp/dockerd.log 2>&1 & while ! docker info >/dev/null 2>&1; do sleep 1; done; cd /opt/acacia && exec node src/remote-worker.mjs"


def run_prefix(request):
    run_key, run_id = request["runKey"], request["runId"]
    if not re.fullmatch(r"[a-f0-9]{24,64}", run_key) or not re.fullmatch(r"[a-f0-9]{12}", run_id):
        raise ValueError("Invalid run identity")
    return f"runs/{run_key}/{run_id}"


def recording_path(request):
    segment = request.get("segment")
    if segment is not None and not re.fullmatch(r"[a-f0-9]{12}", segment):
        raise ValueError("Invalid recording segment")
    prefix = f"{run_prefix(request)}/recording"
    return f"{prefix}/segments/{segment}/recording.webm" if segment else f"{prefix}/recording.webm"


class ChunkReader:
    def __init__(self, chunks):
        self.chunks = iter(chunks)
        self.buffer = b""

    def read(self, length):
        while len(self.buffer) < length:
            try:
                self.buffer += next(self.chunks)
            except StopIteration:
                break
        result, self.buffer = self.buffer[:length], self.buffer[length:]
        return result


def create_worker(image_id, run_key):
    import modal

    if not re.fullmatch(r"im-[A-Za-z0-9]+", image_id):
        raise ValueError("Invalid release image ID")
    if not re.fullmatch(r"[a-f0-9]{24,64}", run_key):
        raise ValueError("Invalid run key")
    app = modal.App.lookup(APP_NAME, create_if_missing=True)
    volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True, version=2)
    sandbox = modal.Sandbox.create(
        "sh", "-c", BOOT, app=app, image=modal.Image.from_id(image_id), runtime="vm", timeout=86400,
        cpu=(0.5, 3.0), memory=(2048, 7168),
        volumes={"/runs": volume.with_mount_options(sub_path=f"runs/{run_key}")},
        tags={"app": "acacia", "run": run_key},
        readiness_probe=modal.Probe.with_tcp(8080),
    )
    try:
        sandbox.wait_until_ready(timeout=180)
        credentials = sandbox.create_connect_token(port=8080)
        return {"sandboxId": sandbox.object_id, "url": credentials.url, "token": credentials.token}
    except BaseException:
        sandbox.terminate(wait=True)
        raise


def main():
    import modal

    request = json.load(sys.stdin)
    command = request.get("command")
    if command == "create":
        result = create_worker(request["imageId"], request["runKey"])
    elif command == "build":
        from modal_release import build_release
        app = modal.App.lookup(APP_NAME, create_if_missing=True)
        result = build_release(app, request["path"], request["commit"], request["workingTree"],
                               request["digest"], base_image_id=request.get("baseImageId"))
    elif command in ("poll", "terminate", "recover"):
        sandbox_id = request["sandboxId"]
        if not re.fullmatch(r"sb-[A-Za-z0-9]+", sandbox_id):
            raise ValueError("Invalid Sandbox ID")
        sandbox = modal.Sandbox.from_id(sandbox_id)
        if command == "recover":
            try:
                exit_code = sandbox.poll()
            except modal.exception.NotFoundError:
                exit_code = -1
            if exit_code is None:
                credentials = sandbox.create_connect_token(port=8080)
                result = {"sandboxId": sandbox_id, "url": credentials.url, "token": credentials.token, "alive": True}
            else:
                result = {"alive": False, "exitCode": exit_code}
        else:
            result = {"exitCode": sandbox.poll() if command == "poll" else sandbox.terminate(wait=True)}
    elif command == "budget":
        summary = modal.Workspace.from_context().billing.summary()
        result = {"meteredUsd": str(summary.metered_cost), "cycleStart": summary.start.isoformat(),
                  "cycleEnd": summary.end.isoformat(), "fetchedAt": datetime.now(timezone.utc).isoformat()}
    elif command == "stats":
        sandbox_id = request["sandboxId"]
        if not re.fullmatch(r"sb-[A-Za-z0-9]+", sandbox_id):
            raise ValueError("Invalid Sandbox ID")
        until = datetime.now(timezone.utc) - timedelta(minutes=5)
        stats = modal.Sandbox.from_id(sandbox_id)._experimental_stats(since=until - timedelta(minutes=10), until=until)
        result = {"costUsd": str(stats.cost) if stats.cost is not None else None,
                  "durationSeconds": stats.duration.total_seconds(), "since": stats.since.isoformat(), "until": stats.until.isoformat()}
    elif command in ("recording-stat", "recording-stream"):
        from modal.types import FileEntryType
        path = recording_path(request)
        volume = modal.Volume.from_name(VOLUME_NAME)
        if command == "recording-stat":
            try:
                entries = volume.listdir(path.rsplit("/", 1)[0])
            except modal.exception.NotFoundError:
                entries = []
            match = next((entry for entry in entries if entry.path.rsplit("/", 1)[-1] == "recording.webm" and entry.type == FileEntryType.FILE), None)
            result = {"size": match.size if match else 0}
        else:
            start, end = request["start"], request["end"]
            if not isinstance(start, int) or not isinstance(end, int) or start < 0 or end < start:
                raise ValueError("Invalid byte range")
            offset = 0
            for chunk in volume.read_file(path):
                next_offset = offset + len(chunk)
                if next_offset > start and offset <= end:
                    sys.stdout.buffer.write(chunk[max(0, start - offset):min(len(chunk), end + 1 - offset)])
                offset = next_offset
                if offset > end:
                    break
            if offset <= end:
                raise ValueError("Recording is shorter than expected")
            return
    elif command == "artifact-list":
        from modal.types import FileEntryType
        prefix = run_prefix(request) + "/recording"
        volume = modal.Volume.from_name(VOLUME_NAME)
        try:
            entries = volume.listdir(prefix, recursive=True)
        except modal.exception.NotFoundError:
            entries = []
        segments = []
        original = False
        for entry in entries:
            if entry.type != FileEntryType.FILE or not entry.size:
                continue
            if entry.path == prefix + "/recording.webm":
                original = True
            match = re.fullmatch(re.escape(prefix) + r"/segments/([a-f0-9]{12})/recording\.webm", entry.path)
            if match:
                segments.append({"id": match.group(1), "mtime": entry.mtime})
        result = {"original": original, "segments": [item["id"] for item in sorted(segments, key=lambda item: item["mtime"])]}
    elif command == "artifact-stream":
        from modal.types import FileEntryType
        prefix = run_prefix(request)
        volume = modal.Volume.from_name(VOLUME_NAME)
        kind = request.get("kind")
        if kind in ("server-log", "bot-log"):
            path = prefix + ("/server.log" if kind == "server-log" else "/mine-ai.log")
            for chunk in volume.read_file(path):
                sys.stdout.buffer.write(chunk)
        elif kind == "world":
            world = prefix + "/server/world"
            entries = volume.listdir(world, recursive=True)
            with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as archive:
                for entry in sorted(entries, key=lambda item: item.path):
                    if entry.type != FileEntryType.FILE or not entry.path.startswith(world + "/"):
                        continue
                    relative = entry.path[len(world) + 1:]
                    if not relative or any(part in ("", ".", "..") for part in relative.split("/")) or relative == "session.lock":
                        continue
                    info = tarfile.TarInfo("world/" + relative)
                    info.size = entry.size
                    info.mode = 0o644
                    archive.addfile(info, ChunkReader(volume.read_file(entry.path)))
        else:
            raise ValueError("Invalid artifact type")
        return
    elif command in ("session-list", "session-stream"):
        from modal.types import FileEntryType
        prefix = run_prefix(request) + "/controller"
        volume = modal.Volume.from_name(VOLUME_NAME)
        pattern = r"\d{4}-\d\d-\d\dT[0-9TZ-]+_[a-f0-9-]+\.jsonl"
        if command == "session-list":
            try:
                entries = volume.listdir(prefix)
            except modal.exception.NotFoundError:
                entries = []
            sessions = [entry for entry in entries if entry.type == FileEntryType.FILE and entry.size and
                        re.fullmatch(pattern, entry.path.rsplit("/", 1)[-1], re.IGNORECASE)]
            result = {"sessions": [entry.path.rsplit("/", 1)[-1] for entry in sorted(sessions, key=lambda entry: entry.mtime, reverse=True)]}
        else:
            name = request["name"]
            if not re.fullmatch(pattern, name, re.IGNORECASE):
                raise ValueError("Invalid session name")
            for chunk in volume.read_file(prefix + "/" + name):
                sys.stdout.buffer.write(chunk)
            return
    elif command == "write-reflection":
        run_key, run_id = request["runKey"], request["runId"]
        if not re.fullmatch(r"[a-f0-9]{24,64}", run_key) or not re.fullmatch(r"[a-f0-9]{12}", run_id):
            raise ValueError("Invalid run identity")
        body = json.dumps(request["reflection"], ensure_ascii=False).encode()
        if len(body) > 16384:
            raise ValueError("Reflection is too large")
        volume = modal.Volume.from_name(VOLUME_NAME)
        with volume.batch_upload(force=True) as upload:
            upload.put_file(io.BytesIO(body), f"runs/{run_key}/{run_id}/controller/reflection.json", mode=0o600)
        result = {"saved": True}
    else:
        raise ValueError("Unknown Modal control command")
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Modal control failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
