/**
 * Runs the processing loop once against the real inbox using .env. Manual testing only.
 */
import 'dotenv/config';
import { loadConfig } from '../lib/config.js';
import { runProcessing } from '../lib/runtime.js';

const config = loadConfig();
const summary = await runProcessing(config);
console.log(JSON.stringify(summary, null, 2));
if (summary.fatalError) process.exitCode = 1;
