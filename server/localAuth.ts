import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "./db";
import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET || "golden-crm-local-secret-change-in-production";
const TOKEN_EXPIRY = "7d";

export interface LocalUser {
  id: string;
  name: string;
  phone: string;
  email: string;
  role: string;
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function generateToken(user: LocalUser): string {
  return jwt.sign({ uid: user.id, email: user.email, role: user.role }, JWT_SECRET, {
    expiresIn: TOKEN_EXPIRY,
  });
}

export function verifyToken(token: string): { uid: string; email: string; role: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { uid: string; email: string; role: string };
  } catch {
    return null;
  }
}

export function createUser(email: string, password: string, name = "", phone = ""): LocalUser {
  const id = `local_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const hash = hashPassword(password);
  db.prepare(
    "INSERT INTO users (id, name, phone, email, password_hash, role) VALUES (?, ?, ?, ?, ?, 'admin')"
  ).run(id, name, phone, email, hash);
  return { id, name, phone, email, role: "admin" };
}

export function findUserByEmail(email: string): LocalUser | null {
  const row = db.prepare("SELECT id, name, phone, email, role FROM users WHERE email = ?").get(email) as any;
  return row || null;
}

export function findUserByPhone(phone: string): LocalUser | null {
  const row = db.prepare("SELECT id, name, phone, email, role FROM users WHERE phone = ?").get(phone) as any;
  return row || null;
}

export function findUserById(id: string): LocalUser | null {
  const row = db.prepare("SELECT id, name, phone, email, role FROM users WHERE id = ?").get(id) as any;
  return row || null;
}

export function authenticate(email: string, password: string): LocalUser | null {
  const row = db.prepare("SELECT id, name, phone, email, password_hash, role FROM users WHERE email = ?").get(email) as any;
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return { id: row.id, name: row.name, phone: row.phone, email: row.email, role: row.role };
}
