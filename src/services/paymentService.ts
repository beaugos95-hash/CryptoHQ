import type { Payment } from "../types/payment";

const STORAGE_KEY = "cryptohq_payments";

export const paymentService = {
  getAll(): Payment[] {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  },

  save(payments: Payment[]) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payments));
  },

  add(payment: Payment) {
    const payments = this.getAll();
    payments.push(payment);
    this.save(payments);
  },
};