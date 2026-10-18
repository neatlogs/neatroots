# Static Chroma component

This component is wired to the ambient controller and Settings; all outputs remain opt-in.
It is disabled on construction. The controller combines global and per-output opt-in before
calling `setEnabled(true)`. An inactive signal disables it. Explicit re-enable is required after
service failure; there is no retry loop. A new explicit enable during failure cleanup is preserved,
and disable/re-enable retires the previous session before registering a replacement. `close()` clears timers and waits for bounded cleanup.

`status()` returns only enabled, phase (inactive/connecting/ready/unavailable), named state and
a fixed service-unavailable error. It contains no run identifiers or service response text.
Only the state selects a static BGR color: live blue, checking violet, loop amber, error red,
interrupted dim amber, attention yellow, incomplete grey, success green. Idle clears lighting.
Success is accepted only as an upstream state; this component never infers check completion.

One serialized owner registers at fixed `http://localhost:54235/razer/chromasdk`, requests the
selected devices (ChromaLink by default), and uses the returned HTTP session on the same loopback hostname and a dynamically
assigned port, at exactly `/chromasdk`. Credentials, query strings, fragments, other hosts,
paths, protocols and redirects are rejected before follow-up. Test options permit an ephemeral
loopback registration port; never populate these from configuration or environment variables.
Requests default to 1500ms and responses to 16KiB. Updates coalesce to the latest state and a
single heartbeat flag; heartbeat cadence is one second; due heartbeats take priority over further effects. Cleanup sends
CHROMA_NONE then DELETE, best effort. A delayed registration is allowed to finish within its
bound so disable can delete its session; an unreachable service can prevent remote cleanup.
No response can prove deletion when the service stops responding.

Protocol references: [registration](https://assets.razerzone.com/dev_portal/REST/html/md__r_e_s_t_external_01_init.html)
returns a session ID and dynamically assigned URI; [heartbeat](https://assets.razerzone.com/dev_portal/REST/html/md__r_e_s_t_external_10_8heartbeat.html)
returns a tick, with one-second recommended cadence; [ChromaLink](https://assets.razerzone.com/dev_portal/REST/html/md__r_e_s_t_external_08_8chromalink.html)
uses CHROMA_STATIC / CHROMA_NONE and result zero for success. The current documentation also
exposes GET at the registration endpoint for SDK version probing. This component does not probe
or register until enabled. Documentation versions differ; no platform matrix is verified.

Manual validation remains PENDING: after integration, explicitly enable against the official
[Chroma Emulator](https://github.com/WyvrnOfficial/ChromaEmulator), inspect all static states,
kill switch and teardown, then repeat on one real device. No emulator or physical device has been tested.


## Optional motion and devices

Construction defaults to disabled, static and ChromaLink-only. The controller uses the saved
animation and device settings to construct `ChromaOutput`; enabling
still requires the global/per-output gates outside this component. Options are fixed for
that owner, and arbitrary endpoint paths are rejected. All six allowed devices are
`chromalink`, `keyboard`, `mouse`, `mousepad`, `headset`, `keypad`. Device lists are copied,
deduplicated and put in that order. Every selected device uses PUT with either
`{ effect: "CHROMA_NONE" }` or `{ effect: "CHROMA_STATIC", param: { color: BGR } }`.
Registration declares only the chosen devices; disable clears each before deleting the session.

Animation uses static-color frames at a nominal 10fps, never deprecated SDK breathing effects.
Live breathes over four seconds; loops pulse amber each second. Error stays red, interrupted
stays dim amber and incomplete stays grey. Upstream success alone holds green for 1.2 seconds,
fades over 1.8 seconds, then clears and stops its frame timer. Repeated identical state signals
do not restart motion; a genuine state change or explicit fresh enable does. Only heartbeat
continues after a completed fade while the owner stays enabled. There are no run identifiers
or payloads in frames, and no inference that checking or run completion means success.

One frame and one pending tick are bounded in memory. Slow devices complete that frame in order,
with due heartbeat checked between every device request. Intermediate ticks are dropped;
subsequent frames use elapsed time rather than replaying a backlog. State changes cancel unsent
devices of the old frame. In-flight requests finish within their existing timeout; disable then
clears every selected device. Actual frame smoothness and cross-device synchronization depend
on service response time and remain unverified on hardware.

Primary endpoint/static/clear references (all checked for the same request shape):
- [Keyboard](https://assets.razerzone.com/dev_portal/REST/html/md__r_e_s_t_external_03_keyboard.html)
- [Mouse](https://assets.razerzone.com/dev_portal/REST/html/md__r_e_s_t_external_04_mouse.html)
- [Mousepad](https://assets.razerzone.com/dev_portal/REST/html/md__r_e_s_t_external_05_mousemat.html)
- [Headset](https://assets.razerzone.com/dev_portal/REST/html/md__r_e_s_t_external_06_headset.html)
- [Keypad](https://assets.razerzone.com/dev_portal/REST/html/md__r_e_s_t_external_07_keypad.html)
- [ChromaLink](https://assets.razerzone.com/dev_portal/REST/html/md__r_e_s_t_external_08_8chromalink.html)

Pending manual checks after integration: explicitly choose virtual devices in the official
emulator; inspect a full live breath and loop pulse, steady error/interrupted/incomplete,
and success hold/fade. Repeat the same state without restarting its animation, change states
mid-frame, and toggle the kill switch mid-animation. Verify clearing all chosen devices on
shutdown; repeat on one real device. These are a verification plan, not completed device tests.
