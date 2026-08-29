import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Eyes } from "../src/components/Eyes";
import { pickShape, type FaceMode, type FaceShape } from "../src/lib/face";
import "./eyes-harness.css";

const NAMES = ["OpenBot", "Ada", "Bob", "Piper", "Aria", "Scout"];
const SHAPE_LABELS: Record<FaceShape, string> = {
  sphere: "black sphere",
  capsule: "soft square",
  "rounded-cube": "squircle",
  diamond: "rounded lozenge",
  bean: "teardrop",
  shield: "rounded hex",
};

function ThemePanel({ theme }: { theme: "light" | "dark" }) {
  const [working, setWorking] = useState(true);
  const activeMode: FaceMode = working ? "write" : "idle";

  return (
    <section className={`theme-panel ${theme === "dark" ? "dark" : ""}`} data-theme={theme}>
      <header className="theme-header">
        <div>
          <h1>{theme === "dark" ? "Dark" : "Light"} theme</h1>
          <p>Exact production Eyes at sidebar, thread, and empty-Chat sizes</p>
        </div>
        <button type="button" data-testid={`toggle-${theme}`} onClick={() => setWorking((value) => !value)}>
          {working ? "End turn" : "Start working"}
        </button>
      </header>

      <div className="face-grid">
        {NAMES.map((name) => (
          <article className="face-card" key={name} data-face-card={`${theme}-${name}`}>
            <h2>{name}</h2>
            <p>{SHAPE_LABELS[pickShape(name)]}</p>
            <div className="face-sizes">
              <span className="sample">
                <Eyes name={name} size={112} mode="idle" />
                empty Chat, 112px
              </span>
            </div>
            <div className="face-compact">
              <span className="sample">
                <Eyes name={name} size={28} mode="idle" />
                idle, 28px
              </span>
              <span className="sample">
                <Eyes name={name} size={28} mode={activeMode} />
                {working ? "working" : "ended"}, 28px
              </span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function Harness() {
  return (
    <main className="harness">
      <ThemePanel theme="light" />
      <ThemePanel theme="dark" />
    </main>
  );
}

const harnessRoot = createRoot(document.getElementById("root")!);
harnessRoot.render(<Harness />);

if (import.meta.hot) {
  import.meta.hot.dispose(() => harnessRoot.unmount());
}
