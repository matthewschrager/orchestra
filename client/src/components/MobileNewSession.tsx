import { useState } from "react";
import type { ProjectWithStatus, SlashCommand } from "shared";
import { SlashCommandInput } from "./SlashCommandInput";

interface MobileNewSessionProps {
  projects: ProjectWithStatus[];
  agents: Array<{ name: string; detected: boolean }>;
  commands: SlashCommand[];
  activeProjectId: string | null;
  onNewThread: (agent: string, prompt: string, isolate: boolean, projectId: string) => void;
}

export function MobileNewSession({
  projects,
  agents,
  commands,
  activeProjectId,
  onNewThread,
}: MobileNewSessionProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(activeProjectId);
  const [prompt, setPrompt] = useState("");
  const [isolate, setIsolate] = useState(false);
  const defaultAgent = agents.find((a) => a.detected)?.name ?? "claude";
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <div className="text-4xl mb-3 opacity-50">+</div>
        <div className="text-content-2 font-medium">No projects</div>
        <div className="text-content-3 text-sm mt-1">
          Add a project from the sidebar first.
        </div>
      </div>
    );
  }

  const handleSubmit = () => {
    if (!prompt.trim() || !selectedProjectId) return;
    onNewThread(defaultAgent, prompt.trim(), isolate, selectedProjectId);
    setPrompt("");
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-2">
        <h2 className="text-lg font-semibold text-content-1 mb-3">New Session</h2>

        {/* Project selector */}
        <label className="text-xs font-medium text-content-3 uppercase tracking-wider mb-1.5 block">
          Project
        </label>
        <div className="space-y-1.5 mb-4">
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() => setSelectedProjectId(project.id)}
              className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors min-h-[44px] ${
                selectedProjectId === project.id
                  ? "border-accent bg-accent/10 text-content-1"
                  : "border-edge-1 bg-surface-1 text-content-2 hover:border-edge-2"
              }`}
            >
              <div className="text-sm font-medium">{project.name}</div>
              <div className="text-[10px] text-content-3 font-mono mt-0.5">
                {project.currentBranch}
                {project.activeThreadCount > 0 && (
                  <span className="text-emerald-400 ml-2">{project.activeThreadCount} running</span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Prompt area */}
      {selectedProject && (
        <div className="flex-1 flex flex-col px-4 pb-4">
          <label className="text-xs font-medium text-content-3 uppercase tracking-wider mb-1.5 block">
            Prompt
          </label>
          <div className="flex-1 min-h-0">
            <SlashCommandInput
              value={prompt}
              onChange={setPrompt}
              onSubmit={handleSubmit}
              commands={commands}
              placeholder={`What should the agent do in ${selectedProject.name}?`}
              rows={4}
            />
          </div>

          <div className="flex items-center justify-between mt-3">
            <label className="flex items-center gap-2 text-sm text-content-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isolate}
                onChange={(e) => setIsolate(e.target.checked)}
                className="rounded"
              />
              Worktree
            </label>
            <button
              onClick={handleSubmit}
              disabled={!prompt.trim() || !selectedProjectId}
              className="px-5 py-2.5 bg-accent hover:bg-accent/80 disabled:opacity-40 rounded-lg text-sm font-medium text-white min-h-[44px]"
            >
              Start Session
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
