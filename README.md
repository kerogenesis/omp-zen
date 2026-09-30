# omp-zen

OpenCode Zen: free models for omp and pi — install, paste your key, and pick a model.  
Always up to date, no reinstalls needed.

## Install

### `oh-my-pi`

```bash
omp install github:kerogenesis/omp-zen
```

### `pi`

```bash
pi install git:github.com/kerogenesis/omp-zen
```

1. Get an API key at <https://opencode.ai/zen> (sign in → billing → copy key).
2. `/login pi-zen` — stores the key in `~/.omp/agent/auth.json` (or `~/.pi/agent/auth.json`).
3. `/model` → pick a `pi-zen/*` model.

## Env

- `ZEN_API_KEY` — headless/CI use (skips `/login`)
- `ZEN_BASE_URL` — override the endpoint (default `https://opencode.ai/zen/v1`)
- `PI_CODING_AGENT_DIR` — alternate agent config dir

## License

MIT
