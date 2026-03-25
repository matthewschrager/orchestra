import type { Attachment } from "shared";

interface Props {
  attachments: Attachment[];
  onRemove?: (id: string) => void;
  uploading?: boolean;
}

/** Thumbnail strip shown in InputBar before sending, and inline in ChatView messages */
export function AttachmentPreview({ attachments, onRemove, uploading }: Props) {
  return (
    <div className="flex gap-2 mb-2 flex-wrap">
      {attachments.map((att) => (
        <div
          key={att.id}
          className="relative group rounded-lg border border-edge-2 bg-surface-2 overflow-hidden"
        >
          {att.mimeType.startsWith("image/") ? (
            <img
              src={att.url}
              alt={att.filename}
              className="h-20 w-20 object-cover"
            />
          ) : (
            <div className="h-20 w-20 flex flex-col items-center justify-center p-2">
              <FileIcon mimeType={att.mimeType} />
              <span className="text-[10px] text-content-3 truncate w-full text-center mt-1">
                {att.filename}
              </span>
            </div>
          )}

          {/* Remove button — only when editable */}
          {onRemove && (
            <button
              onClick={() => onRemove(att.id)}
              className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              title="Remove"
            >
              &times;
            </button>
          )}

          {/* File size badge */}
          <div className="absolute bottom-0.5 left-0.5 px-1 rounded text-[9px] bg-black/50 text-white/80">
            {formatSize(att.size)}
          </div>
        </div>
      ))}

      {/* Upload spinner */}
      {uploading && (
        <div className="h-20 w-20 rounded-lg border border-edge-2 bg-surface-2 flex items-center justify-center">
          <svg className="animate-spin h-5 w-5 text-content-3" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      )}
    </div>
  );
}

/** Inline attachment display for messages in ChatView */
export function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  return (
    <div className="flex gap-2 flex-wrap mt-2">
      {attachments.map((att) => (
        <a
          key={att.id}
          href={att.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block rounded-lg border border-edge-2 overflow-hidden hover:border-accent transition-colors"
        >
          {att.mimeType.startsWith("image/") ? (
            <img
              src={att.url}
              alt={att.filename}
              loading="lazy"
              className="max-h-64 max-w-md object-contain"
            />
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 bg-surface-2">
              <FileIcon mimeType={att.mimeType} />
              <div>
                <div className="text-sm text-content-1">{att.filename}</div>
                <div className="text-xs text-content-3">{formatSize(att.size)}</div>
              </div>
            </div>
          )}
        </a>
      ))}
    </div>
  );
}

function FileIcon({ mimeType }: { mimeType: string }) {
  const isPdf = mimeType === "application/pdf";
  const isText = mimeType.startsWith("text/");

  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-content-3">
      <path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" />
      <path d="M9 1v4h4" />
      {isPdf && <text x="4" y="12" fontSize="5" fill="currentColor" stroke="none" className="font-mono">PDF</text>}
      {isText && (
        <>
          <line x1="5" y1="8" x2="11" y2="8" />
          <line x1="5" y1="10" x2="9" y2="10" />
        </>
      )}
    </svg>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
