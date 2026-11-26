# Death audit: current Minecraft bot build

The audit covered the local Acacia run history and the Modal `acacia-runs-v2`
artifact volume available from this machine. Eleven completed Modal runs died
with the same Minecraft bot source as the running Modal release
`decafea04d8a0258a704ae0a7d9f6aa3b35a9febeb423db8fcf11044c761b281`.
The earlier Modal release had a different overall digest, but its bot source
and Docker build inputs matched. At the start of the audit, the local image had
a different image ID but matching bot build inputs. No local death from that build was
present in the local history when checked. This is not an inventory of any
other, unconnected computer.

For each death, the audit used its full death-triggered bot incident, the
server death message, and the run's available action and reflection history.
Each incident retains the last 20 seconds, subject to its byte budget; it is
not a complete recording of the whole run. Run IDs below can be found in the
dashboard's Runs history. Their metadata and summaries are under
`~/.local/share/mine-ai/<run-id>/`; the original incidents are on the Modal
volume under `runs/<runKey>/<run-id>/bot/`.

| Run | Observed death | Relevant evidence and limit |
| --- | --- | --- |
| `a2354c24a3e7` | Spider | Nighttime wood collection with neither armor nor shield; sustained melee damage with multiple spiders. |
| `1458ea971eac` | Skeleton | Long climb from underground; multiple mob and arrow hits during combat and withdrawal, without a shield. |
| `c470c1f3dcac` | Fire while fighting blaze | Repeated fireballs and burning in the Nether; the shield had broken earlier. |
| `6e4e4169000f` | Skeleton | A shield was present, but hits continued; an attempted recovery shelter could not close because a copper stair occupied a required wall cell. |
| `177b78bbcddb` | Skeleton | Deep stone collection with no armor, shield, or recovery food; the final recorded arrows interrupted an attempted recovery. |
| `7ae9df4b0af8` | Spider | No armor or shield; five three-point hits brought health from about 14.7 to zero in about five seconds. |
| `25b783d98a89` | Fire after lava | Escaped direct lava contact at about 6.9 health, but continued burning without available extinguishing water or recovery food. |
| `d36f249b08e9` | Fire after blaze attacks | Shield broke during repeated blaze encounters; fireballs and lingering fire exhausted health despite some regeneration. |
| `bbfc897ebbd0` | Skeleton | During a cow hunt, the unshielded bot approached a skeleton and encountered a second skeleton and a zombie; health fell from 20 to 0 in roughly four seconds. |
| `157ec3c03d52` | Skeleton | Unarmored, unshielded cow hunt; four arrows brought health from 20 to zero, with no usable recovery food. |
| `32bd40e1a62c` | Blaze fireball | A returning Nether run continued at about 1.8 health and 7 hunger with no food; a fireball killed the bot during another hostile encounter. The trace does not establish whether reachable cover could have saved it. |

The repeated pattern is exposure before the bot has a shield, armor, or
recovery food; it is not a single proven defect behind all eleven deaths. Fire
and close-range spider attacks remain separate problems. Two current-build
runs, `9bc49a389a9c` and `65bb2d6c204d`, ended because their runtime or
Minecraft connection was lost, not because the player died; they are outside
the death count.

## Changes and verification

An incidental ranged hostile now prompts an unshielded bot without a usable
bow to withdraw when it has room and retreat is permitted. Explicit hunts,
close defense, and an already-answered withdrawal keep their existing rules.
In an isolated hard-difficulty scenario, the original response survived two of
three repetitions; one solo bot was killed by arrows. The changed response
survived five of five repetitions. These are small, randomized samples, not a
proof that withdrawal is always safe. Two repetitions of a separate active
cow-hunt scenario resumed and collected the requested drop after withdrawal.

Shelter construction can now replace a stair obstructing its wall when digging
is permitted, a suitable tool can do it within 1.5 seconds, and no adjacent
or waterlogged liquid would be released. An isolated Minecraft scenario with
the recorded copper stair reproduced the old failure; with the fix it replaced
the stair, enclosed the bot, and recovered from 5 to 20 health. The test uses
an inert skeleton to isolate construction and does not prove survival under
live fire. Automated tests also cover refused digging and adjacent lava.

These fixes do not address the underlying supply decisions, the spider
encounters, or all sources of Nether fire. Each running world keeps the
release it started with, and the batch snapshots the latest checkout for a
new run. Two replacement worlds started while the changes were being tested,
so they contain intermediate versions rather than the final tested source.
