#!/usr/bin/env node

import chalk from 'chalk';
import arg from 'arg';
import inquirer from 'inquirer';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import pkg from './package.json' assert { type: 'json' };
import { get_encoding, encoding_for_model } from '@dqbd/tiktoken';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import YAML from 'yaml';

const configPath = path.join(os.homedir(), '.explain-config');

const args = arg({
  '--help': Boolean,
  '--version': Boolean,
  '--ext': [String],
  '--filter': [String],
  '--cwd': String,
  '--model': String,
  '--temperature': Number,
  '--prompt': String,
  '--max-tokens': Number,
  '--reset-key': Boolean,

  '-h': '--help',
  '-v': '--version',
  '-e': '--ext',
  '-f': '--filter',
  '-m': '--model',
  '-t': '--temperature',
  '-p': '--prompt',
  '-mt': '--max-tokens',
  '-r': '--reset-key',
});

if (args['--reset-key']) {
  try {
    await fs.unlink(configPath);
    console.log(chalk.bgGreen('Successfully deleted ~/.explain-config'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(chalk.red('~/.explain-config does not exist'));
    } else {
      console.log(chalk.red(error.message));
    }
  }

  console.log();
}

dotenv.config({
  path: '~/.explain-config',
});

let OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (args['--version']) {
  console.log(`v${pkg.version}`);
  process.exit(0);
}

if (args['--help']) {
  console.log(`
  ${chalk.bold('explain')} [options]

  ${chalk.bold('Options')}
    -h, --help              Shows this help message
    -v, --version           Shows the version number
    -e, --ext               Only consider files with the given extension
    -f, --filter            Only consider files that include the given string
    --cwd                   The directory to run in (defaults to ./)
    -m, --model             The model to use
    -t, --temperature       The temperature to use
    -p, --prompt            The prompt to use
    -mt, --max-tokens       The maximum number of tokens to use
    -r, --reset-key         Resets the OpenAI API key by deleting ~/.explain-config

  ${chalk.bold('Examples')}
    ${chalk.gray('# Explain all files in the current directory')}
    ${chalk.cyan('$ explain')}
    ${chalk.gray('# Explain all files in the current directory with the .js extension')}
    ${chalk.cyan('$ explain --ext js')}
    ${chalk.gray('# Explain all files in the current directory with the .js and .ts extension')}
    ${chalk.cyan('$ explain --ext js --ext ts')}
    ${chalk.gray('# Explain all files in the current directory with the .js and .ts extension using the davinci model')}
    ${chalk.cyan('$ explain --ext js --ext ts --model davinci')}
    ${chalk.gray(
      '# Explain all files in the current directory with the .js and .ts extension using the davinci model with a temperature of 0.5',
    )}
    ${chalk.cyan('$ explain --ext js --ext ts --model davinci --temperature 0.5')}
    ${chalk.gray(
      '# Explain all files in the current directory with the .js and .ts extension using the davinci model with a temperature of 0.5 and a prompt of "Explain the following code:"',
    )}
    ${chalk.cyan(
      '$ explain --ext js --ext ts --model davinci --temperature 0.5 --prompt "Explain the following code:"',
    )}
    ${chalk.gray(
      '# Explain all files in the current directory with the .js and .ts extension using the davinci model with a temperature of 0.5 and a prompt of "Explain the following code:" and a maximum of 800 tokens',
    )}
    ${chalk.cyan(
      '$ explain --ext js --ext ts --model davinci --temperature 0.5 --prompt "Explain the following code:" --max-tokens 800',
    )}
  `);
  process.exit(0);
}

const DEFAULT_PROMPT = `
Explain the following code. Focus on a high level overview. Use bullet points.
`;

const options = {
  ext: args['--ext'],
  filter: args['--filter'],
  cwd: args['--cwd'] ? path.resolve(args['--cwd']) : process.cwd(),
  model: args['--model'] || 'gpt-3.5-turbo',
  temperature: args['--temperature'] || 0.8,
  prompt: (args['--prompt'] || DEFAULT_PROMPT).trim(),
  maxTokens: args['--max-tokens'] || 400,
};

console.log(chalk.bold('Using options:'));
console.log(chalk.cyan(YAML.stringify(options)));
console.log();

const encoding = encoding_for_model(options.model);

const COMMON_JUNK_DIRS = ['node_modules', '.git', '.next', '.vscode', '.idea', '.github', 'dist', 'build'];

async function* getFiles(dir) {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    if (COMMON_JUNK_DIRS.includes(dirent.name)) continue;

    const res = path.resolve(dir, dirent.name);
    if (dirent.isDirectory()) {
      yield* getFiles(res);
    } else {
      yield res;
    }
  }
}

const files = [];

for await (const f of getFiles(options.cwd)) {
  // if filter is set and file path does not include any of the filter strings, skip
  if (options.filter && !options.filter.some((filter) => f.includes(filter))) {
    continue;
  }

  // if ext is set and file path does not end with any of the ext strings, skip
  if (options.ext && !options.ext.some((extension) => f.endsWith(extension))) {
    continue;
  }

  files.push(f);
}

if (files.length === 0) {
  console.log(chalk.red('No matching files found'));
  process.exit(1);
}

const inquirerQuestions = [
  {
    type: 'checkbox',
    name: 'files',
    message: 'Which files do you want an explanation for?',
    choices: files.map((file) => path.relative(options.cwd, file)),
    pageSize: 20,
    async validate(files) {
      let tokenCount = 0;

      for await (const file of files) {
        const absolute = path.resolve(options.cwd, file);
        const content = await fs.readFile(absolute, 'utf8');
        const count = encoding.encode(content).length;

        tokenCount += count;
      }

      // TODO read this from list models api
      const MAX_TOKEN = 4000;

      if (tokenCount > MAX_TOKEN) {
        throw new Error(
          `You selected files with a sum of ${tokenCount} tokens. The maximum is ${MAX_TOKEN}. Please select fewer files.`,
        );
      }

      return true;
    },
  },
];

if (!OPENAI_API_KEY) {
  inquirerQuestions.push({
    type: 'password',
    name: 'apiKey',
    message: 'Please enter your OpenAI API key. It will be stored in ~/.explain-config',
    mask: '*',
  });
}

inquirer
  .prompt(inquirerQuestions)
  .then(explain)
  .catch((error) => {
    if (error.isTtyError) {
      throw new Error("Inquirer Error: Prompt couldn't be rendered in the current environment (TTY error)");
    }

    throw error;
  });

async function explain(answers) {
  if (answers.apiKey) {
    OPENAI_API_KEY = answers.apiKey.trim();

    await fs.writeFile(configPath, `OPENAI_API_KEY=${OPENAI_API_KEY}`, 'utf-8');

    console.log(chalk.green(`API key stored in ${configPath}`));
  }

  const contents = await Promise.all(
    answers.files.map(async (relative) => {
      const absolute = path.resolve(options.cwd, relative);
      const content = await fs.readFile(absolute, 'utf-8');
      return {
        relative,
        absolute,
        content,
      };
    }),
  );

  function fileContentToMessage({ absolute, relative, content }) {
    return {
      role: 'user',
      content: `Filename: ${relative}\n\n\`\`\`\n${content}\n\`\`\`\n`.trim(),
    };
  }

  const messages = [
    {
      role: 'system',
      content: `
        You are an experienced software engineer with computer science background. You are great at explaining code to others.
      `.trim(),
    },
    {
      role: 'user',
      content: options.prompt.trim(),
    },
    ...contents.map((content) => fileContentToMessage(content)),
  ];

  console.log();
  console.log(chalk.green.bold('Talking to OpenAI...'));

  const resp = await fetch(`https://api.openai.com/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      messages,
      model: options.model,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    }),
  });

  const json = await resp.json();

  if (json.error) {
    console.log();
    console.log(chalk.red.bold('OpenAI error:'));
    console.log();
    console.log(json.error.message);
    process.exit(1);
  }

  console.log();
  console.log(chalk.blue.bold('OpenAI says:'));
  console.log();
  console.log(json.choices[0].message.content);

  if (json.choices[0].finish_reason !== 'stop') {
    console.log();
    console.log(chalk.red(`OpenAI stopped early, reason: ${json.choices[0].finish_reason}`));
  }
}
