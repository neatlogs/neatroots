# Ambient outputs

Ambient outputs follow run state on the server. The reference log output stays local and content-free. Chroma lighting is a separate opt-in
that contacts only the local service, with optional animation and a finite device selection.
No network request is made by disabled outputs. See [Chroma details](ambient-chroma.md).

Open **Settings → Ambient outputs**. **Enable ambient outputs** and each desired output must be on, then choose **Save ambient
settings**. The global switch, log and Chroma outputs are all off on a new install. Animation
is off and ChromaLink is the initial device selection. Changes to device/animation preferences
are saved even with the global switch off. Failed saves preserve the form for correction.
The global switch stops the subscriber and its timer while retaining the output preference.
Stopping the server does the same cleanup. The log emits only the named state and active-run
count, never project labels, prompts, tool results or finding text.

```yaml
ambient:
  enabled: false
  outputs:
    log:
      enabled: false
    chroma:
      enabled: false
      animation: false
      devices: [chromalink]
```

`POST /api/settings` accepts boolean `ambient_enabled`, `ambient_log_enabled`,
`ambient_chroma_enabled`, `ambient_chroma_animation`, and `ambient_chroma_retry` fields, plus
a nonempty `ambient_chroma_devices` list from the documented allowlist. Retry requires both
global and Chroma enablement. Transport URLs and timing overrides are not API options.
Invalid values reject the request before applying any changes. `GET /api/status` includes
`ambient`: configured switches, whether the subscriber is active, the selected named state,
project/workflow/run labels, active-run count and a log-error flag. Its `chroma` snapshot
reports configured/enabled state, connecting/ready/unavailable/inactive phase, animation and
device preferences. Unavailability does not retry automatically; use **Retry Chroma connection**.

## Reading the signal

- **Run live**: the run has not ended.
- **Loop finding**: a raised/active loop-group finding, including repeated tools, cycles,
  runaway loops, tool error streaks or unrecovered failures.
- **Run failed** and **Run interrupted** follow the run's own outcome, not a check's error.
- **Open findings**: other raised/active findings need attention.
- **Checking run**: end-of-run check work is explicitly outstanding.
- **Checks incomplete**: no trustworthy completion evidence, unavailable/interrupted checks,
  a failed check or an invalid check registry. This is not a failed-run signal.
- **Checks settled**: an explicit successful check completion, with no open or failed findings.
  Root-span completion or an empty pending queue alone never establishes success.

Active work takes priority over finished history. Among active runs, findings come first;
newer arrival time wins within a state, then the trace ID. With no active work, only the
newest run may show its outcome. Once it expires, older failures do not take its place.
Updates to a run do not reorder equal-priority runs. The status labels always identify the selected run, and show the number of active runs.
All active runs are retained; recent finished outcomes are bounded to 64. On enable, the
subscriber discovers existing live runs and the most recently received result. Successful
results settle for ten seconds, other finished results remain for thirty seconds, then
clear. The log receives static named states. Chroma defaults to static colors; optional motion
breathes/pulses live and loop states, and fades success after three seconds.

## Output seam

`AmbientOutput.setState(signal)` receives a small value with state, labels and a count.
The server owns one subscriber, catches output failures and reports them in Settings.
An `inactive` signal asks an output to cancel its work. The reference output is synchronous;
future device outputs must own their cancellation and never act after disable. No webhook
or speculative device interface is part of this stage.


## Completion evidence

Success requires the engine's current-generation completion receipt: the end pass finished,
no accepted work remains, and no check failed. Changed evidence after the end pass requires
an explicit recheck before success can show again. Real-engine tests cover settled success,
changed evidence, and the fresh recheck; injected states alone are not completion evidence.

The controller isolates log/device failures and serializes Chroma teardown before replacement.
Global disable unsubscribes the run observer and cancels owned timers; bounded in-flight cleanup
may finish afterward. No labels or trace content leave via either output. Emulator/real-device
verification remains pending and no hardware support is claimed by the fake-server tests.
