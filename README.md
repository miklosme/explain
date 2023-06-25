# Explain

Tiny CLI utility to use OpenAI's GPT to explain code

## Usage

```bash
# this will list files in the current directory
# select the ones you are interested in
$ npx explain
```

## Options

    -h, --help              Shows this help message
    -v, --version           Shows the version number
    -f, --filter            File extensions to filter for
    -m, --model             The model to use
    -t, --temperature       The temperature to use
    -p, --prompt            The prompt to use
    -mt, --max-tokens       The maximum number of tokens to use
    -r, --reset-key         Resets the OpenAI API key by deleting ~/.explain-config

## License

MIT
