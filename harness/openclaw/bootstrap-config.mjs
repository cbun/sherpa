import fs from "node:fs";
import path from "node:path";

const openclawHome = process.env.OPENCLAW_HOME ?? "/home/openclaw";
const openclawConfigDir = process.env.OPENCLAW_CONFIG_DIR ?? path.join(openclawHome, ".openclaw");
const workspace = process.env.OPENCLAW_WORKSPACE ?? "/workspace";
const gatewayPort = Number.parseInt(process.env.OPENCLAW_GATEWAY_PORT ?? "18789", 10);
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "sherpa-harness-token";
const gatewayAuthMode = process.env.OPENCLAW_GATEWAY_AUTH_MODE ?? "none";
const modelPrimary = process.env.OPENCLAW_MODEL_PRIMARY ?? "openai/gpt-5.4";
const fallbackModels = (process.env.OPENCLAW_MODEL_FALLBACKS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const agentId = process.env.SHERPA_HARNESS_AGENT_ID ?? "main";
const hostConfigPath = process.env.OPENCLAW_HOST_CONFIG_PATH ?? "/host-openclaw/openclaw.json";
const copyHostAuth = process.env.OPENCLAW_COPY_HOST_AUTH === "1";
const harnessMode = process.env.SHERPA_HARNESS_MODE ?? "advisory";
const sherpaEnabled = harnessMode !== "none" && process.env.SHERPA_PLUGIN_ENABLED !== "0";
const advisoryEnabled =
  process.env.SHERPA_ADVISORY_ENABLED === undefined || process.env.SHERPA_ADVISORY_ENABLED === ""
    ? harnessMode === "advisory"
    : process.env.SHERPA_ADVISORY_ENABLED === "1";
const advisoryThreshold = Number.parseFloat(process.env.SHERPA_ADVISORY_THRESHOLD ?? "0.75");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function pathExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function copyFileIfExists(source, destination) {
  if (!pathExists(source)) {
    return false;
  }

  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o600);
  return true;
}

function copyHostAgentAuth() {
  if (!copyHostAuth) {
    return;
  }

  const hostConfigDir = path.dirname(hostConfigPath);
  const sourceAgentDir = path.join(hostConfigDir, "agents", agentId, "agent");
  const targetAgentDir = path.join(openclawConfigDir, "agents", agentId, "agent");
  for (const fileName of ["auth-profiles.json", "auth-state.json", "models.json"]) {
    copyFileIfExists(path.join(sourceAgentDir, fileName), path.join(targetAgentDir, fileName));
  }
}

function buildConfig() {
  const hostConfig = copyHostAuth && pathExists(hostConfigPath) ? readJson(hostConfigPath) : null;
  const modelEntries = Object.fromEntries([modelPrimary, ...fallbackModels].map((model) => [model, {}]));

  const config = {
    agents: {
      defaults: {
        model: {
          primary: modelPrimary,
          fallbacks: fallbackModels
        },
        models: modelEntries,
        workspace
      },
      list: [
        {
          id: agentId,
          name: agentId,
          workspace,
          agentDir: path.join(openclawConfigDir, "agents", agentId, "agent")
        }
      ]
    },
    tools: {
      profile: "coding",
      exec: {
        security: "full",
        ask: "off"
      }
    },
    commands: {
      native: "auto",
      nativeSkills: "auto",
      bash: true,
      restart: true,
      ownerDisplay: "raw"
    },
    session: {
      dmScope: "per-channel-peer"
    },
    gateway: {
      port: gatewayPort,
      mode: "local",
      bind: "loopback",
      auth:
        gatewayAuthMode === "none"
          ? {
              mode: "none"
            }
          : {
              mode: "token",
              token: gatewayToken
            }
    },
    plugins: {
      entries: {
        sherpa: {
          enabled: sherpaEnabled,
          hooks: {
            allowConversationAccess: true
          },
          config: {
            transport: {
              mode: "embedded"
            },
            store: {
              root: path.join(openclawConfigDir, "agents", "{agentId}", "sherpa")
            },
            advisory: {
              enabled: advisoryEnabled,
              injectThreshold: Number.isFinite(advisoryThreshold) ? advisoryThreshold : 0.75
            },
            scope: {
              default: "deny",
              rules: [
                {
                  action: "allow",
                  match: {
                    agentId
                  }
                },
                {
                  action: "allow",
                  match: {
                    chatType: "direct"
                  }
                },
                {
                  action: "allow",
                  match: {
                    chatType: "dm"
                  }
                }
              ]
            }
          }
        }
      }
    }
  };

  if (hostConfig?.auth) {
    config.auth = hostConfig.auth;
  }

  return config;
}

ensureDir(openclawConfigDir);
ensureDir(path.join(openclawConfigDir, "agents", agentId));
copyHostAgentAuth();

const config = buildConfig();
const configPath = path.join(openclawConfigDir, "openclaw.json");
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

if (copyHostAuth && !pathExists(hostConfigPath)) {
  console.error(`[sherpa-harness] OPENCLAW_COPY_HOST_AUTH=1 but no host config was found at ${hostConfigPath}`);
}

if (!config.auth && modelPrimary.startsWith("openai-codex/")) {
  console.error(
    "[sherpa-harness] openai-codex models usually require existing OpenClaw auth. " +
      "Mount host auth or switch OPENCLAW_MODEL_PRIMARY to an API-key-backed provider."
  );
}

console.error(
  `[sherpa-harness] wrote ${configPath} with primary model ${modelPrimary}, agent ${agentId}, mode ${harnessMode}`
);
