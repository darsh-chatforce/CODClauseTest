# Operation Nightfall — how to play

Clear a walled compound of six hostiles at dusk. Alone, or with up to three
other people against the same AI.

---

## Run it

```bash
npm install
npm run dev          # Vite on :5178 AND the co-op server on :8787
```

Open **http://localhost:5178/** and press **DEPLOY**.

Click the canvas once when the mission starts — the browser only hands over the
mouse (pointer lock) on a click, and look control needs it. Press **Esc** to
give it back.

Two other entry points, both occasionally useful:

| command | what it starts |
| --- | --- |
| `npm run dev:solo` | Vite only. No server, no co-op, and the game is complete. |
| `npm run server` | The co-op server only, on `:8787`. Point clients at it. |

---

## The single-player game works with the server switched off

This is a design rule, not an accident. `src/net/` is removable: `Game.net` is
`null` in single player, nothing in boot touches a socket, and every use of the
network is guarded. If the server is not running — or is running and refuses
your room code, or dies mid-mission — the start screen says *"playing solo · the
server is optional"* and you get the full M3 game: same arena, same AI, same
weapon, same scoring.

Nothing in the offline game waits on the network, so nothing in the offline game
can be broken by it.

---

## Co-op, in three steps

Co-op is on the **start screen**, under the DEPLOY button.

1. **One player hosts.** Type a callsign (optional) and press **HOST**. The
   status line turns green and shows a four-character room code:
   `ROOM K7QP · 1 in the compound · share the code`.
2. **Share the code.** It is four characters from an alphabet with no `0`, `O`,
   `1`, `I`, `5` or `S` in it, because the whole point is that somebody reads it
   out loud over voice chat and nobody has to ask "letter or number?".
3. **Everyone else joins.** Type the code into the ROOM CODE box, press
   **JOIN**, then **DEPLOY**. Up to four soldiers per room.

Teammates appear as the same rigged soldier you are, in a friendlier tint, with
their callsign floating above them. Their locomotion is reconstructed from their
movement, so they walk, run and crouch as you would expect.

### What is shared, and what is yours

| | who owns it |
| --- | --- |
| The six hostiles — position, state, health, death | **The server.** One AI, one truth. Everybody sees the same soldier take the same knee. |
| Whether your round hit, and what it killed | **The server.** You send an origin and a direction; it does the raycast. |
| Where you are standing | **You.** Your movement is simulated locally and never waits for a round trip, so the game feels the same online as off. |
| The kill feed | **Shared.** `ALPHA ELIMINATED HOSTILE 03` on everyone's screen, in the same order, including your own kills as `YOU`. |
| Restarting the mission | **The server.** REDEPLOY resets the compound for the whole room at once, so two people can never be in different missions in the same building. |

If someone quits or drops, their avatar disappears within a snapshot or two and
everyone else plays on.

### Playing across machines

The client connects to `ws://<the page's hostname>:8787` by default, so hosting
on a LAN is just "run `npm run dev` on one box and have everyone open that box's
address". To point somewhere else, add a query parameter:

```
http://localhost:5178/?server=ws://192.168.1.20:8787
```

---

## Controls

| input | action |
| --- | --- |
| **W A S D** *(or arrow keys)* | Move |
| **Mouse** | Look |
| **Left mouse** | Fire — 5.56 × 45, 30-round magazine, 120 in reserve |
| **Right mouse** *(hold)* | Aim down sight — narrower FOV, much tighter cone |
| **Shift** | Sprint — you cannot fire while sprinting, and ADS drops if you start |
| **Space** | Jump |
| **C** *(or Left Ctrl)* | Crouch — slower, shorter, steadier |
| **R** | Reload — the magazine actually leaves the weapon |
| **T** | Third-person inspect camera. Drag to orbit, **T** again to return. |
| **Esc** | Pause, and the settings panel |

Reloading happens on its own when the magazine runs dry and you are still
holding the trigger.

## Settings

The same three toggles appear on the start screen and the pause screen, and
changing one takes effect immediately:

| toggle | default | notes |
| --- | --- | --- |
| **POST-PROCESSING** | ON | Selective bloom, the dusk grade, vignette and SMAA. Measured at a locked 60 fps (16.67 ms) on the development machine. Turning it off is a look change, not a relight — both paths agree on exposure to within 0.026 of mean luminance. |
| **AMBIENT OCCLUSION** | OFF | Ships off because it was measured, not because it looks wrong: GTAO costs 18.9–22.8 ms mean and 33.4 ms p95, which is 44–53 fps. It is here for anyone with the headroom. |
| **AUDIO** | ON | Everything is synthesised at runtime — no audio files ship. |

Want the low-end render path from a cold boot rather than toggled mid-session?
Load **`?postfx=0`**:

```
http://localhost:5178/?postfx=0
```

---

## The mission

Six hostiles, one two-storey compound, no respawns for them and none for you.

The AI plays by one doctrine rule you can rely on: **it never fires while
moving.** A soldier that wants to shoot you must halt, aim, and then fire, and
that telegraph is the window you play in. It is enforced as an in-engine
invariant and audited on every run of the test suite — zero violations, or the
build is red.

They will flank, use the stairs, and reposition when they lose sight of you.
Score comes from kills, headshots, the time you took and your accuracy.
