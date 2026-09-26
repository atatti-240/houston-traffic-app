"use client";

import type { Camera } from "@/lib/types";

export default function CameraModal({ camera, onClose }: { camera: Camera | null; onClose: () => void }) {
  if (!camera) return null;
  return (
    <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">{camera.kind === "train" ? "Train crossing camera" : "TranStar highway camera"}</div>
            <div className="font-semibold">{camera.name}</div>
          </div>
          <button onClick={onClose} className="text-slate-500" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="relative flex aspect-video items-center justify-center bg-slate-900 text-center text-slate-300">
          <div className="absolute left-3 top-3 flex items-center gap-1.5 text-xs text-red-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> LIVE (mock)
          </div>
          <div className="px-8 text-sm">
            📷 Mock feed.
            <br />
            The real {camera.kind === "train" ? "crossing" : "TranStar CCTV"} stream plugs in here.
          </div>
        </div>
        <div className="px-4 py-3 text-xs text-slate-500">
          Source: <code className="break-all">{camera.url}</code>
        </div>
      </div>
    </div>
  );
}
