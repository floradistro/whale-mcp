/**
 * Subagent Worker — runs in separate thread to not block UI
 *
 * Usage: Spawned by parallel_tasks via worker_threads
 *
 * This worker runs `runSubagent()` in isolation, keeping the main thread
 * (and Ink UI) responsive. Results are posted back via parentPort.
 */

import { parentPort, workerData } from "worker_threads";
import { runSubagent, type SubagentOptions, type SubagentResult } from "./subagent.js";

export interface WorkerData {
  options: SubagentOptions;
  index: number;  // Task index for result ordering
}

export interface WorkerResult {
  success: boolean;
  index: number;
  result?: SubagentResult;
  error?: string;
}

async function main() {
  if (!parentPort) {
    console.error("subagent-worker must be run as a worker thread");
    process.exit(1);
  }

  const { options, index } = workerData as WorkerData;

  // Send progress updates (optional, for debugging)
  const reportProgress = (msg: string) => {
    parentPort!.postMessage({ type: "progress", index, message: msg });
  };

  try {
    reportProgress(`Starting ${options.subagent_type} subagent...`);

    const result = await runSubagent(options);

    reportProgress(`Completed ${options.subagent_type} subagent`);

    const response: WorkerResult = {
      success: true,
      index,
      result,
    };
    parentPort.postMessage({ type: "result", ...response });
  } catch (err: any) {
    const response: WorkerResult = {
      success: false,
      index,
      error: err.message || String(err),
    };
    parentPort.postMessage({ type: "result", ...response });
  }
}

main();
