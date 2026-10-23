import 'dotenv/config'

function exigir(nome) {
  const valor = process.env[nome]
  if (!valor) throw new Error(`Variável de ambiente ${nome} não configurada (veja .env.example)`)
  return valor
}

export const SUPABASE_URL = exigir('SUPABASE_URL')
export const SUPABASE_SERVICE_ROLE_KEY = exigir('SUPABASE_SERVICE_ROLE_KEY')
export const GROQ_API_KEY = exigir('GROQ_API_KEY')
// Opcional: só precisa na primeira conexão, pra pedir o código de pareamento
// em vez de QR (útil quando o WhatsApp tá no mesmo aparelho que roda o bot).
// Só números, com DDI+DDD, sem +, espaço ou traço (ex: 5511999999999).
export const WHATSAPP_PHONE_NUMBER = process.env.WHATSAPP_PHONE_NUMBER || null
// Segredo do biofarol (WHATSAPP_CODIGO_SECRET) — só precisa pro !novocodigo funcionar.
export const CODIGO_SECRET = process.env.CODIGO_SECRET || null
