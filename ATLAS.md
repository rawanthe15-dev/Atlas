# Atlas — Vision Document

## What Atlas Is

Atlas is not a chatbot. It is an AI system built to **make things happen** — a second brain, a powerhouse connector, and an autonomous agent that bridges the gap between you and every system, device, and service in your world.

Atlas's core purpose is twofold:
1. **Know you deeply** — learn your patterns, remember what you forgot, surface what you didn't notice about yourself, and build a living model of who you are and how you operate.
2. **Connect to everything** — plug Atlas into any device, service, or system and it figures out how to work with it autonomously. Not through pre-built native integrations, but through intelligent self-bridging.

---

## The Original Vision (in the user's own words)

> "i want to make Atlas a ai system capable of effortlessly making things happen not only should it be a assistant the main point is it should be extremely well at connecting to things even not natively supported via some implementation for example plug in atlas once to your phone and now it can work autonomously there or get atlas to learn how to turn and turn off your tv know patterns and be your 2nd brain knowing things that you forgot and learning more things about you that you dont even learn yourself easily being a assistant but also being a powerhouse at making things happen connecting to systems autonomously knowing how to change models by itself or for example i buy a drone i plug atlas in and now atlas reads the dir and based on my info learns exactly how the drone works making a connection bridge now it knows that it doesnt have vision capability so it uses a direction agent for example they could choose from north east south and west and all of these have different abilities and prompts to suit various needs basically agents with fancy names he chooses one with vision and the ability to stream realtime and work autonomously in realtime and now i have a drone that atlas can use to find things around the house and so on"

---

## Core Principles

### 1. Connect to Anything
Atlas is not limited to natively supported integrations. When you introduce Atlas to a new device or system, it:
- Reads available documentation, directories, APIs, and specs
- Builds a connection bridge autonomously
- Exposes that device's capabilities as tools it can use
- Learns the device's limits and works around them using agents

### 2. Self-selecting Agents
Atlas knows its own capability gaps. When a task requires something it can't do natively (e.g. vision, real-time streaming, directional navigation), it selects or spawns a specialized agent. Agents have personalities, names, and specific capability sets tuned for their domain. Atlas picks the right agent for the job — the user never has to.

### 3. Living Memory
Atlas remembers everything relevant. It builds a model of the user that goes beyond what the user consciously tells it — learning from patterns, routines, habits, and behaviors. It knows what you forgot, surfaces things before you need them, and grows smarter the longer it runs.

### 4. Model Agnostic / Self-upgrading
Atlas knows what models it has access to and selects the right one for each task. It can switch models mid-task if needed. It doesn't get stuck on one provider or capability set.

### 5. Own Everything It Builds
Atlas is built from scratch — not assembled from cloned repos. The architecture is informed by how efficient systems like PicoClaw, OpenClaw, and Omi Desktop work, but every line belongs to Atlas. We study their principles and build something better.

---

## Key Capabilities (Full Vision)

| Capability | Description |
|---|---|
| Second Brain | Persistent, growing knowledge of the user — memories, patterns, preferences, forgotten things |
| Device Bridging | Plug Atlas into any device; it reads, learns, and builds a connection bridge autonomously |
| Agent Spawning | Selects or creates specialized agents when a task requires capabilities it lacks |
| Model Switching | Chooses the right model for the task; switches automatically based on need |
| Real-time Operation | Capable of streaming, continuous operation, and autonomous loops |
| Perceptual Layer | Can see screen, hear audio, observe the environment via connected devices |
| Smart Home | Learns device patterns (TV on/off, lights, sensors) and acts autonomously |
| Drone / Robotics | Reads hardware capabilities, spawns directional/vision agents, pilots autonomously |
| Phone Integration | Plugged in once, operates autonomously on the device |

---

## Drone Example (Canonical Use Case)

> "i buy a drone i plug atlas in and now atlas reads the dir and based on my info learns exactly how the drone works making a connection bridge now it knows that it doesnt have vision capability so it uses a direction agent for example they could choose from north east south and west and all of these have different abilities and prompts to suit various needs basically agents with fancy names he chooses one with vision and the ability to stream realtime and work autonomously in realtime and now i have a drone that atlas can use to find things around the house"

**What this means architecturally:**
1. User introduces a drone to Atlas
2. Atlas reads the drone's SDK/docs/directory
3. Atlas generates a connection bridge (tool definitions, capability map)
4. Atlas identifies gaps: "this drone has no vision processing"
5. Atlas selects a vision-capable streaming agent from its agent registry
6. Atlas combines: drone control tools + vision agent + user's home context
7. Atlas can now pilot the drone autonomously to locate objects, map rooms, patrol

---

## Build Philosophy

- **No cloned repos.** Study how efficient systems work; build our own.
- **PicoClaw taught us:** compiled tight, single binary, <10MB — apply that discipline to every component
- **OpenClaw taught us:** 3-layer separation (input → gateway → agent), markdown memory, MCP-native
- **Omi Desktop taught us:** always-on perceptual capture, VAD segmentation, memory extraction pipeline
- **We build better.**

---

## Development Phases

### Phase 1 — Core Foundation (NOW)
- Terminal CLI with unique Atlas ASCII interface
- Micro-kernel + plugin architecture
- Async-native throughout (asyncio + httpx)
- OpenRouter API (DeepSeek v4 Pro / free providers)
- Memory layer with clean interface + swappable backend
- Basic agent loop with tool calling
- Session persistence (JSONL)
- USER.md and SOUL.md living memory files

### Phase 2 — Interface Expansion
- Telegram bot interface (plugin, zero kernel changes)
- Voice input (wake word, whisper transcription)
- Floating desktop overlay

### Phase 3 — Device Connectivity
- Universal connection bridge system
- MCP server auto-generation for new devices
- PicoClaw-inspired edge node protocol (our own, Go or Rust)
- Phone integration
- Smart home (TV, lights, sensors)

### Phase 4 — Autonomous Operation
- Real-time streaming loops
- Drone / robotics agent system
- Vision agent integration
- Self-directed task execution without prompting

### Phase 5 — Full Second Brain
- Perceptual layer (screen + audio capture, Omi-inspired)
- Pattern recognition across behavior
- Proactive surfacing ("you usually do X around now")
- Complete user model

---

## Technical Constraints

- **Current platform:** M1 MacBook (inference via OpenRouter — DeepSeek v4 Pro or free providers)
- **Future:** Local inference on a PC; edge nodes on ARM/RISC-V hardware
- **Language:** Python 3.11+ (async-native, asyncio + httpx)
- **No heavy frameworks:** Agno/LangGraph are reference points, not dependencies
- **Memory:** Interface-driven, JSONL + markdown first, vector backend later
- **Everything is a plugin** after the kernel

---

## What Atlas Is Not

- Not a wrapper around an existing agent framework
- Not a Jarvis/Alexa clone
- Not a productivity app with AI features bolted on
- Not dependent on any single provider, model, or platform
