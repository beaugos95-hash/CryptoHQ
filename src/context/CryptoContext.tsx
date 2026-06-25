import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
type Payment = {
  amount: number;
  date: string;
};

type CryptoContextType = {
  payments: Payment[];
  addPayment: (amount: number) => void;
};

const CryptoContext = createContext<CryptoContextType | null>(null);

export function CryptoProvider({ children }: { children: ReactNode }) {
  const [payments, setPayments] = useState<Payment[]>([]);

  function addPayment(amount: number) {
    setPayments((old) => [
      ...old,
      {
        amount,
        date: new Date().toLocaleDateString(),
      },
    ]);
  }

  return (
    <CryptoContext.Provider
      value={{
        payments,
        addPayment,
      }}
    >
      {children}
    </CryptoContext.Provider>
  );
}

export function useCrypto() {
  const context = useContext(CryptoContext);

  if (!context) {
    throw new Error("useCrypto doit être utilisé dans CryptoProvider");
  }

  return context;
}