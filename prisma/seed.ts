import "dotenv/config";
import { PrismaClient, type RequestType, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@cityfix.com";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "Admin@12345";
const DEMO_PASSWORD = "Demo@12345";

const departments = [
  {
    name: "Roads & Infrastructure",
    description: "Potholes, footpaths, street lights and road damage",
    contactEmail: "roads@cityfix.com",
  },
  {
    name: "Waste Management",
    description: "Garbage collection, drains and public cleanliness",
    contactEmail: "waste@cityfix.com",
  },
  { name: "Water & Sewerage", description: "Water supply, leaks and sewer lines", contactEmail: "water@cityfix.com" },
  {
    name: "Licensing & Permits",
    description: "Trade licences, permits and certificates",
    contactEmail: "permits@cityfix.com",
  },
];

const categories: {
  name: string;
  department: string;
  type: RequestType;
  slaHours: number;
  serviceFee: number;
  description: string;
}[] = [
  {
    name: "Pothole / Road Damage",
    department: "Roads & Infrastructure",
    type: "COMPLAINT",
    slaHours: 72,
    serviceFee: 0,
    description: "Damaged road surface",
  },
  {
    name: "Broken Street Light",
    department: "Roads & Infrastructure",
    type: "COMPLAINT",
    slaHours: 48,
    serviceFee: 0,
    description: "Street light not working",
  },
  {
    name: "Missed Garbage Collection",
    department: "Waste Management",
    type: "COMPLAINT",
    slaHours: 24,
    serviceFee: 0,
    description: "Scheduled pickup did not happen",
  },
  {
    name: "Blocked Drain",
    department: "Waste Management",
    type: "COMPLAINT",
    slaHours: 48,
    serviceFee: 0,
    description: "Clogged or overflowing drain",
  },
  {
    name: "Water Leakage",
    department: "Water & Sewerage",
    type: "COMPLAINT",
    slaHours: 24,
    serviceFee: 0,
    description: "Leaking supply line",
  },
  {
    name: "Bulk Waste Pickup",
    department: "Waste Management",
    type: "SERVICE",
    slaHours: 72,
    serviceFee: 500,
    description: "On-demand pickup of construction or bulk waste",
  },
  {
    name: "New Water Connection",
    department: "Water & Sewerage",
    type: "SERVICE",
    slaHours: 168,
    serviceFee: 2500,
    description: "Application for a new household connection",
  },
  {
    name: "Trade Licence Application",
    department: "Licensing & Permits",
    type: "SERVICE",
    slaHours: 120,
    serviceFee: 1500,
    description: "New trade licence processing fee",
  },
];

const users: { name: string; email: string; password: string; role: Role; department?: string }[] = [
  { name: "City Admin", email: ADMIN_EMAIL, password: ADMIN_PASSWORD, role: "ADMIN" },
  {
    name: "Rahim Uddin (Roads)",
    email: "staff.roads@cityfix.com",
    password: DEMO_PASSWORD,
    role: "STAFF",
    department: "Roads & Infrastructure",
  },
  {
    name: "Karim Hossain (Waste)",
    email: "staff.waste@cityfix.com",
    password: DEMO_PASSWORD,
    role: "STAFF",
    department: "Waste Management",
  },
  {
    name: "Nusrat Jahan (Water)",
    email: "staff.water@cityfix.com",
    password: DEMO_PASSWORD,
    role: "STAFF",
    department: "Water & Sewerage",
  },
  { name: "Demo Citizen", email: "citizen@cityfix.com", password: DEMO_PASSWORD, role: "CITIZEN" },
];

async function main() {
  // Idempotent: safe to run again on an existing database.
  const departmentIds = new Map<string, string>();
  for (const department of departments) {
    const row = await prisma.department.upsert({ where: { name: department.name }, update: {}, create: department });
    departmentIds.set(row.name, row.id);
  }

  for (const { department, ...category } of categories) {
    const departmentId = departmentIds.get(department);
    if (!departmentId) throw new Error(`Unknown department: ${department}`);
    await prisma.category.upsert({
      where: { name: category.name },
      update: {},
      create: { ...category, departmentId },
    });
  }

  for (const user of users) {
    const passwordHash = await bcrypt.hash(user.password, 10);
    await prisma.user.upsert({
      where: { email: user.email },
      update: {},
      create: {
        name: user.name,
        email: user.email,
        passwordHash,
        role: user.role,
        departmentId: user.department ? (departmentIds.get(user.department) ?? null) : null,
      },
    });
  }

  console.log(`Seeded ${departments.length} departments, ${categories.length} categories, ${users.length} users`);
  console.log(`Admin login: ${ADMIN_EMAIL}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
