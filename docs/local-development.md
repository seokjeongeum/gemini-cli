# Local development guide

This guide provides instructions for setting up and using local development
features for Gemini CLI.

## Profile startup during local testing

Use `npm run start:profile` from a source checkout to record startup timings
while you test Gemini CLI interactively. The command runs `npm start` with your
existing authentication, settings, environment, and terminal. Regular
`npm start` runs don't collect profiles.

Install dependencies and build the checkout before your first run:

```bash
npm ci
npm run build
npm run start:profile
```

Pass your usual CLI arguments after `--`, for example:

```bash
npm run start:profile -- --model auto
```

Test normally, then use `/quit` to exit. The profiler prints the output
directory when it starts and a timing summary when Gemini CLI exits. Each run
writes `summary.json` and `process-<pid>.json` files in a separate, ignored
directory under `.gemini/startup-profiles/`. CLI process snapshots are written
after `cli_startup` and the observed startup phases finish. If startup exits
early, the profiler saves any completed phases on exit. Set
`GEMINI_STARTUP_PROFILE_DIR` to save runs under a different directory.

Use the summary fields to compare runs with the same settings and arguments:

- `launchToCliMainMs`: Time from launching the child `npm start` process until
  the CLI enters `main()`, including launcher processes and module loading.
- `preMainMs`: Time from the selected CLI process starting until `main()`.
- `cliStartupEndMs`: Time from launching the child `npm start` process until the
  existing `cli_startup` phase ends. This boundary precedes UI rendering; it
  doesn't measure time to the first visible prompt.

For `check-build-status` and `sandbox-command`, optional `helperDurationMs`
measures Node process startup through its exit callback, before writing the
profile. It includes Node and preload startup but excludes profile file writes
and renames; it isn't an exact timing of the helper's function.

The report lists process starts and named startup phases, including
authentication when that phase runs. Phases can overlap or contain other phases,
so don't add their durations to calculate total startup time. Named phases don't
cover every operation: gaps can include uninstrumented work, process launches,
and module loading. The profile excludes initialization of the outer
`npm run start:profile` command.

For work inside `main()`, check `load_partial_config`, `initial_auth`, and
`load_sandbox_config` before the full configuration and app initialization
phases. Check `read_startup_warnings`, `collect_startup_warnings`, and
`resolve_session` for warnings and session resolution. `startup_oauth` records
Google sign-in setup before rendering when browser launch is suppressed.
`import_interactive_ui` records the dynamic UI module import after `cli_startup`
ends; rendering and time to the first visible prompt aren't measured.

Use the nested phases to inspect the first configuration pass and individual
warning checks:

- Configuration: `detect_worktree`, `check_folder_trust`,
  `resolve_workspace_policies`, `load_policies`, `detect_pty`, and
  `construct_config` separate Git worktree detection, folder trust, workspace
  policy setup, policy loading, native PTY detection, and configuration
  construction. Compare these phases with `load_partial_config` to inspect work
  that runs before configuration is reused.
- Warnings: `home_directory_warning`, `root_directory_warning`,
  `folder_trust_warning`, and `compatibility_warnings` separate filesystem path
  resolution, folder trust, and compatibility checks within
  `collect_startup_warnings`.

Profiling adds its own module loading and report-writing overhead. To compare
launch costs on Windows, run these commands in PowerShell from the same
checkout:

```powershell
Measure-Command { npm start -- --version | Out-Host }
Measure-Command { npm run start:profile -- --version | Out-Host }
```

Repeat both commands with the same environment to estimate the extra cost of the
profiling wrapper. These wall-clock measurements include the outer npm commands.
Running with `--version` measures the version command's launch path rather than
authenticated interactive startup.

If no completed `cli_startup` phase appears, the summary omits the startup
fields. This can happen with `--version`, an early exit, an interrupted
authentication or trust prompt, or a sandboxed CLI process that the profiler
can't observe. Host process timings can still appear in the report.

The profiler writes timing and process metadata locally. It doesn't record
prompts, terminal output, command arguments, environment values, or phase
details, and it doesn't enable telemetry or debugger pauses.

## Tracing

Gemini CLI uses OpenTelemetry (OTel) to record traces that help you debug agent
behavior. Traces instrument key events like model calls, tool scheduler
operations, and tool calls.

Traces provide deep visibility into agent behavior and help you debug complex
issues. They are captured automatically when you enable telemetry.

### View traces

You can view traces using Genkit Developer UI, Jaeger, or Google Cloud.

#### Use Genkit

Genkit provides a web-based UI for viewing traces and other telemetry data.

1.  **Start the Genkit telemetry server:**

    Run the following command to start the Genkit server:

    ```bash
    npm run telemetry -- --target=genkit
    ```

    The script will output the URL for the Genkit Developer UI. For example:
    `Genkit Developer UI: http://localhost:4000`

2.  **Run Gemini CLI:**

    In a separate terminal, run your Gemini CLI command:

    ```bash
    gemini
    ```

3.  **View the traces:**

    Open the Genkit Developer UI URL in your browser and navigate to the
    **Traces** tab to view the traces.

#### Use Jaeger

You can view traces in the Jaeger UI for local development.

1.  **Start the telemetry collector:**

    Run the following command in your terminal to download and start Jaeger and
    an OTel collector:

    ```bash
    npm run telemetry -- --target=local
    ```

    This command configures your workspace for local telemetry and provides a
    link to the Jaeger UI (usually `http://localhost:16686`).

    - **Collector logs:** `~/.gemini/tmp/<projectHash>/otel/collector.log`

2.  **Run Gemini CLI:**

    In a separate terminal, run your Gemini CLI command:

    ```bash
    gemini
    ```

3.  **View the traces:**

    After running your command, open the Jaeger UI link in your browser to view
    the traces.

#### Use Google Cloud

You can use an OpenTelemetry collector to forward telemetry data to Google Cloud
Trace for custom processing or routing.

<!-- prettier-ignore -->
> [!WARNING]
> Ensure you complete the
> [Google Cloud telemetry prerequisites](./cli/telemetry.md#prerequisites)
> (Project ID, authentication, IAM roles, and APIs) before using this method.

1.  **Configure `.gemini/settings.json`:**

    ```json
    {
      "telemetry": {
        "enabled": true,
        "target": "gcp",
        "useCollector": true
      }
    }
    ```

2.  **Start the telemetry collector:**

    Run the following command to start a local OTel collector that forwards to
    Google Cloud:

    ```bash
    npm run telemetry -- --target=gcp
    ```

    The script outputs links to view traces, metrics, and logs in the Google
    Cloud Console.

    - **Collector logs:** `~/.gemini/tmp/<projectHash>/otel/collector-gcp.log`

3.  **Run Gemini CLI:**

    In a separate terminal, run your Gemini CLI command:

    ```bash
    gemini
    ```

4.  **View logs, metrics, and traces:**

    After sending prompts, view your data in the Google Cloud Console. See the
    [telemetry documentation](./cli/telemetry.md#view-google-cloud-telemetry)
    for links to Logs, Metrics, and Trace explorers.

For more detailed information on telemetry, see the
[telemetry documentation](./cli/telemetry.md).

### Instrument code with traces

You can add traces to your own code for more detailed instrumentation.

Adding traces helps you debug and understand the flow of execution. Use the
`runInDevTraceSpan` function to wrap any section of code in a trace span.

Here is a basic example:

```typescript
import { runInDevTraceSpan } from '@google/gemini-cli-core';
import { GeminiCliOperation } from '@google/gemini-cli-core/lib/telemetry/constants.js';

await runInDevTraceSpan(
  {
    operation: GeminiCliOperation.ToolCall,
    attributes: {
      [GEN_AI_AGENT_NAME]: 'gemini-cli',
    },
  },
  async ({ metadata }) => {
    // metadata allows you to record the input and output of the
    // operation as well as other attributes.
    metadata.input = { key: 'value' };
    // Set custom attributes.
    metadata.attributes['custom.attribute'] = 'custom.value';

    // Your code to be traced goes here.
    try {
      const output = await somethingRisky();
      metadata.output = output;
      return output;
    } catch (e) {
      metadata.error = e;
      throw e;
    }
  },
);
```

In this example:

- `operation`: The operation type of the span, represented by the
  `GeminiCliOperation` enum.
- `metadata.input`: (Optional) An object containing the input data for the
  traced operation.
- `metadata.output`: (Optional) An object containing the output data from the
  traced operation.
- `metadata.attributes`: (Optional) A record of custom attributes to add to the
  span.
- `metadata.error`: (Optional) An error object to record if the operation fails.
