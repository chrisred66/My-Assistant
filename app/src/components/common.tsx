import { useState } from "react";
import { PROVIDER_LABELS, PROVIDERS, type Provider } from "../lib/api";

/** "" means the server default (TRANSLATE_PROVIDER). */
export function ProviderSelect({
  value,
  onChange,
  allowDefault = true,
  id,
}: {
  value: Provider | "";
  onChange: (v: Provider | "") => void;
  allowDefault?: boolean;
  id?: string;
}) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value as Provider | "")}>
      {allowDefault && <option value="">Server default</option>}
      {PROVIDERS.map((p) => (
        <option key={p} value={p}>
          {PROVIDER_LABELS[p]}
        </option>
      ))}
    </select>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="small-btn"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="error-text" role="alert">
      {message}
    </p>
  );
}
