export const services = [
  { id: "reset", name: "The reset", description: "A focused back, neck & shoulder massage.", minutes: 30, price: 55, mark: "01" },
  { id: "unwind", name: "Unwind", description: "A full-body massage. A little room to breathe.", minutes: 60, price: 95, mark: "02" },
  { id: "restore", name: "Deep restore", description: "Slow, restorative work for a fresh start.", minutes: 90, price: 135, mark: "03" },
];

export const slots = ["09:00", "11:00", "14:00", "16:00"];

export function catalog() {
  return {
    services,
    slots,
    date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    timezone: "UTC",
  };
}

export function revision() {
  return process.env.PROTECTED_APP_REVISION ?? "booking-demo-v1";
}
