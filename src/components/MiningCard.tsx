import { useState } from "react";
import { useLocalStorage } from "../hooks/useLocalStorage";

export default function MiningCard() {
  const [payments, setPayments] = useLocalStorage<number[]>("payments", []);
  const [value, setValue] = useState("");

  const addPayment = () => {
    const amount = Number(value);

    if (!amount || amount <= 0) return;

    setPayments([...payments, amount]);
    setValue("");
  };

  const total = payments.reduce((a, b) => a + b, 0);

  return (
    <div
      style={{
        background: "#1e293b",
        padding: 20,
        borderRadius: 12,
        marginTop: 20,
      }}
    >
      <h2>⛏️ PearlFortune</h2>

      <h3>Total : {total.toFixed(2)} PRL</h3>

      <input
        type="number"
        placeholder="Ex : 8.42"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        style={{
          padding: 10,
          marginTop: 10,
          marginRight: 10,
        }}
      />

      <button onClick={addPayment}>
        Ajouter un paiement
      </button>

      <ul style={{ marginTop: 20 }}>
        {payments.map((payment, index) => (
          <li key={index}>+ {payment} PRL</li>
        ))}
      </ul>
    </div>
  );
}