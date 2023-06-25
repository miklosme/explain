import chalk from 'chalk';
import arg from 'arg';
import inquirer from 'inquirer';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import pkg from './package.json' assert { type: 'json' };
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';

const configPath = path.join(os.homedir(), '.explain-config');

const args = arg({
  '--help': Boolean,
  '--version': Boolean,
  '--ext': [String],
  '--model': String,
  '--temperature': Number,
  '--prompt': String,
  '--max-tokens': Number,
  '--reset-key': Boolean,

  '-h': '--help',
  '-v': '--version',
  '-e': '--ext',
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
  model: args['--model'] || 'gpt-3.5-turbo',
  temperature: args['--temperature'] || 0.8,
  prompt: args['--prompt'] || DEFAULT_PROMPT,
  maxTokens: args['--max-tokens'] || 400,
};

console.log(chalk.bold('Using options:'));
console.log(chalk.cyan(JSON.stringify(options, null, 2)));
console.log();

async function* getFiles(dir) {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    if (dirent.name === 'node_modules') continue;

    const res = path.resolve(dir, dirent.name);
    if (dirent.isDirectory()) {
      yield* getFiles(res);
    } else {
      yield res;
    }
  }
}

const files = [];

for await (const f of getFiles(process.cwd())) {
  if (!options.ext || options.ext.some((extension) => f.endsWith(extension))) {
    files.push(f);
  }
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
    choices: files.map((file) => path.relative(process.cwd(), file)),
  },
];

if (!OPENAI_API_KEY) {
  inquirerQuestions.push({
    type: 'password',
    name: 'apiKey',
    message: 'Please enter your OpenAI API key. It will be stored in ~/.explain-config',
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
    answers.files.map(async (file) => {
      return {
        file,
        relative: path.relative(process.cwd(), file),
        content: await fs.readFile(file, 'utf-8'),
      };
    }),
  );

  function fileContentToMessage({ file, relative, content }) {
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
