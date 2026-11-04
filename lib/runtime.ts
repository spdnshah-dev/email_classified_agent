/**
 * Wires real dependencies (Gmail client, OpenRouter classifier) from config.
 * Handlers and scripts call these; tests mock this module.
 */
import { createClassifier } from './classify.js';
import type { Config } from './config.js';
import {
  createGmailApi,
  createGmailService,
  type GmailService,
  type WatchResult,
} from './gmail.js';
import type { Logger } from './logger.js';
import { logger as defaultLogger } from './logger.js';
import { processInbox, type ProcessSummary } from './process.js';

export function buildGmailService(config: Config, log: Logger = defaultLogger): GmailService {
  return createGmailService(createGmailApi(config), config, log);
}

export async function runProcessing(
  config: Config,
  log: Logger = defaultLogger,
): Promise<ProcessSummary> {
  const gmail = buildGmailService(config, log);
  const classify = createClassifier({
    apiKey: config.openRouterApiKey,
    model: config.openRouterModel,
    fallbackModels: config.openRouterFallbackModels,
    logger: log,
  });
  return processInbox({ gmail, classify, bodyMaxChars: config.bodyMaxChars, logger: log });
}

export async function renewWatch(
  config: Config,
  log: Logger = defaultLogger,
): Promise<WatchResult> {
  return buildGmailService(config, log).registerWatch();
}
