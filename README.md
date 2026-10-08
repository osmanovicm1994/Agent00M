# Local AI Agent System

A sophisticated local AI agent system that combines command-line interface with a web dashboard for task execution and monitoring.

## Overview

This project provides a local AI coding assistant that can:
- Execute tasks through natural language commands
- Run in both interactive chat mode and automated run mode  
- Integrate with local LLM servers (like LM Studio)
- Provide real-time visualization of agent activities via web dashboard
- Support multiple specialized agents for different types of tasks

## Features

- **CLI Interface**: Command-line interface for running tasks and chatting with the AI assistant
- **Web Dashboard**: Real-time monitoring of agent activities through a browser-based UI  
- **Agent Specialization**: Multiple specialist agents for different programming tasks
- **MCP Integration**: Support for Model Context Protocol servers (e.g., sequential-thinking)
- **Local Execution**: All processing happens locally without sending data to external services

## Prerequisites

- Node.js 18+ 
- Local LLM server (like LM Studio) running on default port
- For web dashboard: Vite development server

## Setup

### Install Dependencies

```bash
npm install
```

### Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` to set your preferred LLM provider and configuration options.

## Usage

### CLI Commands

The main agent is run through `npm run dev` or directly with `tsx src/cli.ts`.

#### Available Commands

- **run** - Execute a task using the local AI assistant  
  ```bash
  npm run run "Implement user authentication system"
  ```

- **chat** - Start an interactive multi-agent chat session  
  ```bash
  npm run chat
  ```

- **agents** - List available specialist agents  
  ```bash
  npm run agents
  ```

- **models** - List models available on the LLM server  
  ```bash
  npm run models
  ```

- **triage-models** - List Gemini models for triage functionality  
  ```bash
  npm run triage-models
  ```

### Web Dashboard

The system supports a real-time web dashboard that shows agent activities:

1. Start the agent with `--serve` flag to enable the dashboard:
   ```bash
   npm run dev -- --serve
   ```

2. The dashboard will be accessible at: http://localhost:5173/?token=[generated-token]

### Web UI Setup

The web interface is located in `/web` directory and uses Vite:

```bash
cd web
npm install
```

#### Available Scripts (in web/package.json)

- `dev`: Start the development server 
- `build`: Build for production
- `preview`: Preview the production build
- `typecheck`: Run TypeScript checks

## Configuration

### Environment Variables

Key environment variables:
- `AI_PROVIDER` - LLM provider to use (default: lmstudio)
- `AI_MODEL_NAME` - Specific model name to use  
- `AGENT_DEFAULT_WORKSPACE` - Default project directory for tasks
- `AGENT_UI_PORT` - Port for the dashboard WebSocket server (default: 3001)
- `GEMINI_API_KEY` - For triage functionality (optional)

### MCP Configuration

The system uses MCP configuration defined in `mcp.config.json`. This file defines which servers to start and how they should be configured.

## Development

### Running the Agent

```bash
# Run a single task  
npm run dev -- "Implement user authentication"

# Start interactive chat session  
npm run chat

# Run with dashboard monitoring
npm run dev -- --serve
```

### Project Structure

- `src/` - Core agent implementation including:
  - `cli.ts` - Main CLI entry point
  - `agents/` - Specialist agent implementations
  - `llm/` - LLM provider integrations  
  - `gateway/` - Triage and external service integrations
  - `core/` - Core execution logic

- `web/` - Web dashboard UI (Vite-based)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes 
4. Submit a pull request

## License

This project is licensed under the MIT License.
