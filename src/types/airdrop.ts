export interface AirdropProject {
  id: string;
  name: string;
  points: number;
  priority: "High" | "Medium" | "Low";
  phase: string;
}
