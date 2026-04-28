#!/usr/bin/env node
import { create, all } from 'mathjs';

const math = create(all);

function showHelp() {
  console.log('Usage: calc "expression"');
  console.log('');
  console.log('A simple calculator CLI for basic arithmetic operations.');
  console.log('');
  console.log('Examples:');
  console.log('  calc "1.0 + 2.0 + 3.0"  -> 6');
  console.log('  calc "10 / 2 * 5"       -> 25');
  console.log('  calc "2 ^ 10"           -> 1024');
  console.log('  calc "sqrt(16) + 2"     -> 6');
}

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  showHelp();
  process.exit(0);
}

const expression = args.join(' ');

try {
  const result = math.evaluate(expression);
  if (typeof result === 'number' || typeof result === 'bigint' || (typeof result === 'object' && result !== null)) {
    console.log(result.toString());
  } else {
    console.log(String(result));
  }
} catch (error) {
  console.error(`Error: Invalid expression or calculation failed. ${error.message}`);
  console.log('\nHint: Use quotes for complex expressions, e.g., calc "1 + 2"');
  process.exit(1);
}
