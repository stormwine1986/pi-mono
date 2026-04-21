#!/usr/bin/env node
import { Command } from 'commander';
import { MetadataClient } from './index.js';

const program = new Command();
const client = new MetadataClient();

program
  .name('metadata-client')
  .description('Metadata Service Client for Node.js')
  .version('0.54.0')
  .argument('<method>', 'HTTP method (GET, POST, etc.)')
  .argument('<path>', 'API path (e.g., /user)')
  .argument('[data]', 'JSON data for POST/PUT requests', '')
  .argument('[params]', 'Query parameters (e.g., uid=123)', '')
  .action(async (method, path, data, params) => {
    try {
      const queryParams: Record<string, string> = {};
      if (params) {
        const searchParams = new URLSearchParams(params);
        searchParams.forEach((value, key) => {
          queryParams[key] = value;
        });
      }

      let body = undefined;
      if (data) {
        try {
          body = JSON.parse(data);
        } catch (e) {
          // If not JSON, but data is provided, maybe it's meant to be a string?
          // For now, we fallback to just data if it fails parsing
          body = data;
        }
      }

      const result = await client.request(method.toUpperCase(), path, queryParams, body);
      
      if (result !== null) {
        process.stdout.write(JSON.stringify(result, null, 2));
      } else {
        process.exit(1);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.parse(process.argv);
