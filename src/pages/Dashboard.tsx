import Sidebar from "../components/Sidebar"
import { projects } from "../data/projects"

export default function Dashboard() {
  return (
    <div
      style={{
        display: "flex",
        background: "#0f172a",
        color: "white",
        minHeight: "100vh",
      }}
    >
      <Sidebar />

      <main style={{ flex: 1, padding: "30px" }}>
        <h1>Bienvenue 👋</h1>

        <div
          style={{
            display: "flex",
            gap: "20px",
            marginTop: "25px",
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              background: "#1e293b",
              padding: "20px",
              borderRadius: "12px",
              width: "220px",
            }}
          >
            <h3>⛏️ Pool</h3>
            <p>PearlFortune</p>
          </div>

          <div
            style={{
              background: "#1e293b",
              padding: "20px",
              borderRadius: "12px",
              width: "220px",
            }}
          >
            <h3>🎁 Airdrops</h3>
            <h2>{projects.length}</h2>
          </div>

          <div
            style={{
              background: "#1e293b",
              padding: "20px",
              borderRadius: "12px",
              width: "220px",
            }}
          >
            <h3>💰 PRL</h3>
            <p>0 PRL</p>
          </div>
        </div>

        <h2 style={{ marginTop: "40px" }}>Mes projets</h2>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))",
            gap: "15px",
            marginTop: "20px",
          }}
        >
          {projects.map((p) => (
            <div
              key={p.name}
              style={{
                background: "#1e293b",
                padding: "15px",
                borderRadius: "12px",
              }}
            >
              <h3>{p.name}</h3>
              <p>Priorité : {p.priority}</p>
              <p>Points : {p.points}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}