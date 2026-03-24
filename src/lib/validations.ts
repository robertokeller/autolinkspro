import { z } from "zod";

export const rotaSchema = z.object({
  name: z.string().trim().min(1, "Nome é obrigatório").max(100, "Máximo 100 caracteres"),
  sourceGroupId: z.string().min(1, "Selecione um grupo de origem"),
});

export const templateSchema = z.object({
  name: z.string().trim().min(1, "Nome é obrigatório").max(100, "Máximo 100 caracteres"),
  content: z.string().trim().min(1, "Conteúdo é obrigatório").max(4000, "Máximo 4000 caracteres"),
  category: z.enum(["oferta", "cupom", "geral"]),
});

export const perfilSchema = z.object({
  name: z.string().trim().min(1, "Nome é obrigatório").max(100, "Máximo 100 caracteres"),
  email: z.string().trim().email("Email inválido").max(255, "Máximo 255 caracteres"),
  phone: z.string().trim().default(""),
});

export const agendamentoSchema = z.object({
  content: z.string().trim().min(1, "Conteúdo é obrigatório").max(4000, "Máximo 4000 caracteres"),
  scheduledAt: z.string()
    .min(1, "Defina a data/hora")
    .refine((value) => !Number.isNaN(new Date(value).getTime()), "Data/hora inválida"),
});
