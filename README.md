# Explain Files

Tiny CLI utility to use OpenAI's GPT to explain code

## Usage

```bash
# basic
$ npx explain-files

# skip the file selector
$ npx explain-files spaghetti.js

# only show .ts and .tsx files in the file selector
$ npx explain-files --ext ts --ext tsx
```

## Options

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

## License

MIT
