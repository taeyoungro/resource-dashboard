import { useState } from "react";
import { api } from "./api";
import { ApprovalPage } from "./components/ApprovalPage";
import { ResourcePage } from "./components/ResourcePage";

type Tab = "approvals" | "resources";

export default function App() {
  const [tab, setTab] = useState<Tab>("approvals");
  const [apiKey, setApiKey] = useState<string>(
    () => window.localStorage.getItem("pipeline_api_key") ?? "",
  );
  const [savedKey, setSavedKey] = useState<string>(apiKey);

  const saveKey = () => {
    api.setApiKey(apiKey);
    setSavedKey(apiKey);
  };

  return (
    <div className="shell">
      <nav className="topnav">
        <div className="brand">IAM Pipeline</div>
        <div className="tabs">
          <button
            className={tab === "approvals" ? "tab active" : "tab"}
            onClick={() => setTab("approvals")}
          >
            관리자 승인
          </button>
          <button
            className={tab === "resources" ? "tab active" : "tab"}
            onClick={() => setTab("resources")}
          >
            리소스 관리
          </button>
        </div>
        <div className="api-key topbar-key">
          <input
            type="password"
            placeholder="X-API-Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button onClick={saveKey}>저장</button>
        </div>
      </nav>
      {tab === "approvals" ? (
        <ApprovalPage apiKey={savedKey} />
      ) : (
        <ResourcePage apiKey={savedKey} />
      )}
    </div>
  );
}
