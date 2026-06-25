export default function Sidebar() {
  return (
    <aside
      style={{
        width: "260px",
        background: "#111827",
        color: "white",
        padding: "20px",
        minHeight: "100vh",
      }}
    >
      <h2 style={{ marginBottom: "30px" }}>🚀 CryptoHQ</h2>

      <nav style={{ display: "flex", flexDirection: "column", gap: "15px" }}>
        <button>🏠 Dashboard</button>
        <button>⛏️ Mining</button>
        <button>🎁 Airdrops</button>
        <button>📊 Statistiques</button>
        <button>⚙️ Paramètres</button>
      </nav>
    </aside>
  )
}