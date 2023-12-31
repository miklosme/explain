#!/usr/bin/env node

import chalk from 'chalk';
import arg from 'arg';
import inquirer from 'inquirer';
import fs from 'fs/promises';
import pkg from './package.json' assert { type: 'json' };
import { get_encoding, encoding_for_model } from '@dqbd/tiktoken';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import YAML from 'yaml';
import { AIStream } from 'ai';

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
  model: args['--model'],
  temperature: args['--temperature'] || 0.8,
  prompt: (args['--prompt'] || DEFAULT_PROMPT).trim(),
  maxTokens: args['--max-tokens'] || 400,
  files: args['_']?.length ? args['_'] : undefined,
};

console.log(chalk.bold('Using options:'));
console.log(chalk.cyan(YAML.stringify(options)));
console.log();

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

const inquirerQuestions = [
  {
    type: 'password',
    name: 'apiKey',
    message: 'Please enter your OpenAI API key. It will be stored in ~/.explain-config',
    mask: '*',
    when: (answer) => !answer.apiKey,
  },
  {
    type: 'list',
    name: 'model',
    message: 'Which model do you want to use?',
    choices: async (answers) => {
      const models = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${answers.apiKey}`,
        },
      }).then((res) => res.json());

      return models.data.map((model) => model.id).filter((id) => id.startsWith('gpt-'));
    },
    when: (answer) => !answer.model,
  },
  {
    type: 'checkbox',
    name: 'files',
    message: 'Which files do you want an explanation for?',
    choices: async () => {
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

      return files.map((file) => path.relative(options.cwd, file));
    },
    pageSize: 20,
    async validate(files, answers) {
      let encoding;
      try {
        encoding = encoding_for_model(answers.model);
      } catch (error) {
        // if tiktoken doesn't know this model, fallback to gpt2
        encoding = get_encoding('gpt2');
      }

      let tokenCount = 0;

      for await (const file of files) {
        const absolute = path.resolve(options.cwd, file);
        const content = await fs.readFile(absolute, 'utf8');
        const count = encoding.encode(content).length;

        tokenCount += count;
      }

      // the model name contains a context size in the form of a number and a "k"
      const size = answers.model.match(/\d+k/);
      const MAX_TOKEN = size ? parseInt(size[0]) * 1000 : 4000;

      if (tokenCount > MAX_TOKEN) {
        throw new Error(
          `You selected files with a sum of ${tokenCount} tokens. The maximum is ${MAX_TOKEN}. Please select fewer files.`,
        );
      }

      return true;
    },
  },
  {
    type: 'confirm',
    name: 'changePrompt',
    message: 'Do you want to change the default prompt?',
    default: false,
    when: () => !args['--prompt'],
  },
  {
    type: 'editor',
    name: 'prompt',
    message: 'What prompt do you want to use?',
    default: DEFAULT_PROMPT,
    askAnswered: true,
    when: (answers) => answers.changePrompt,
  },
];

inquirer
  .prompt(inquirerQuestions, {
    apiKey: OPENAI_API_KEY,
    model: options.model,
    files: options.files,
    prompt: options.prompt,
  })
  .then(explain)
  .catch((error) => {
    if (error.isTtyError) {
      throw new Error("Inquirer Error: Prompt couldn't be rendered in the current environment (TTY error)");
    }

    throw error;
  });

async function explain(answers) {
  if (!OPENAI_API_KEY) {
    OPENAI_API_KEY = answers.apiKey.trim();

    await fs.writeFile(configPath, `OPENAI_API_KEY=${OPENAI_API_KEY}`, 'utf-8');

    console.log(chalk.green(`API key stored in ${configPath}`));
  }

  options.model = answers.model;

  // THIS DOES NOT RETURNS CONTEXT SIZE SO USELESS
  // const modelInfo = await fetch(`https://api.openai.com/v1/models/${options.model}`, {
  //   method: 'GET',
  //   headers: {
  //     'Content-Type': 'application/json',
  //     Authorization: `Bearer ${OPENAI_API_KEY}`,
  //   },
  // }).then((res) => res.json());

  // console.log(modelInfo);

  if (answers.files.length === 0) {
    throw new Error('No files selected');
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
      content: answers.prompt.trim(),
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
      stream: true,
    }),
  });

  console.log();
  console.log(chalk.blue.bold('OpenAI says:'));

  AIStream(resp, (chunk) => {
    const json = JSON.parse(chunk);

    if (json.error) {
      console.log();
      console.log(chalk.red.bold('OpenAI error:'));
      console.log();
      console.log(json.error.message);
      process.exit(1);
    }

    const text = json.choices[0]?.delta?.content ?? json.choices[0]?.text ?? '';
    process.stdout.write(text);

    const finishReason = json.choices[0].finish_reason;

    if (finishReason) {
      if (finishReason !== 'stop') {
        console.log();
        console.log(chalk.red(`OpenAI stopped early, reason: ${json.choices[0].finish_reason}`));
      }

      process.stdout.write('\n');
    }
  });
}
