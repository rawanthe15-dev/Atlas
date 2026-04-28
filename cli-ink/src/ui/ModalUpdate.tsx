import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { Modal } from "./Modal.js";
import { spawn } from "node:child_process";
import { ATLAS_ROOT } from "../config/config.js";

interface Props {
  onClose: () => void;
}

interface UpdateResult {
  status: "checking" | "up-to-date" | "incoming" | "pulling" | "ok" | "error" | "no-remote";
  message?: string;
  log?: string[];
}

function git(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd: ATLAS_ROOT });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (b) => out.push(b));
    proc.stderr.on("data", (b) => err.push(b));
    proc.on("error", (e) =>
      resolve({ code: 1, stdout: "", stderr: e.message }),
    );
    proc.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf-8").trim(),
        stderr: Buffer.concat(err).toString("utf-8").trim(),
      }),
    );
  });
}

/** /update — fetch upstream, show incoming commits, run pull --rebase --autostash. */
export function ModalUpdate({ onClose }: Props): React.ReactElement {
  const [result, setResult] = useState<UpdateResult>({ status: "checking" });

  useInput((_input, _key) => {
    if (result.status !== "checking" && result.status !== "pulling") onClose();
  });

  useEffect(() => {
    void run();
    async function run(): Promise<void> {
      const inRepo = await git(["rev-parse", "--is-inside-work-tree"]);
      if (inRepo.code !== 0 || inRepo.stdout !== "true") {
        setResult({ status: "error", message: "not a git repository" });
        return;
      }
      const remotes = await git(["remote"]);
      if (remotes.code !== 0 || !remotes.stdout) {
        setResult({ status: "no-remote" });
        return;
      }
      await git(["fetch"]);
      const local = await git(["rev-parse", "HEAD"]);
      const remote = await git(["rev-parse", "@{u}"]);
      if (remote.code !== 0) {
        setResult({ status: "error", message: "no upstream branch" });
        return;
      }
      if (local.stdout === remote.stdout) {
        setResult({ status: "up-to-date" });
        return;
      }
      const log = await git(["log", "--oneline", `${local.stdout}..${remote.stdout}`]);
      setResult({ status: "incoming", log: log.stdout.split("\n").filter(Boolean) });
      // Auto-proceed to pull after showing incoming briefly.
      setTimeout(() => {
        void doPull();
      }, 600);
    }
    async function doPull(): Promise<void> {
      setResult((r) => ({ ...r, status: "pulling" }));
      const pull = await git(["pull", "--rebase", "--autostash"]);
      if (pull.code !== 0) {
        setResult({ status: "error", message: pull.stderr || pull.stdout });
        return;
      }
      setResult({ status: "ok", message: "updated. exit and relaunch atlas-ink to load new code." });
    }
  }, []);

  if (result.status === "checking") {
    return (
      <Modal title="update">
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text dimColor> checking for updates...</Text>
        </Box>
      </Modal>
    );
  }
  if (result.status === "no-remote") {
    return (
      <Modal title="update" hint="any key to close">
        <Text color="yellow">⚠  no git remote configured</Text>
      </Modal>
    );
  }
  if (result.status === "up-to-date") {
    return (
      <Modal title="update" hint="any key to close">
        <Text color="green">✓ atlas-ink is up to date</Text>
      </Modal>
    );
  }
  if (result.status === "incoming" || result.status === "pulling") {
    return (
      <Modal title="update">
        <Text bold>incoming changes:</Text>
        {(result.log ?? []).map((l, i) => (
          <Text key={i} dimColor>
            {"  "}
            {l}
          </Text>
        ))}
        {result.status === "pulling" && (
          <Box marginTop={1}>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text dimColor> pulling...</Text>
          </Box>
        )}
      </Modal>
    );
  }
  if (result.status === "ok") {
    return (
      <Modal title="update" hint="any key to close">
        <Text color="green">✓ {result.message}</Text>
      </Modal>
    );
  }
  return (
    <Modal title="update" borderColor="red" hint="any key to close">
      <Text color="red">✗ {result.message ?? "update failed"}</Text>
    </Modal>
  );
}
