/**
 * Calls users.watch once using .env and prints the expiration. Manual testing only.
 */
import 'dotenv/config';
import { loadConfig } from '../lib/config.js';
import { renewWatch } from '../lib/runtime.js';

const config = loadConfig();
const result = await renewWatch(config);
console.log(JSON.stringify({ topic: config.pubsubTopic, ...result }, null, 2));
