import 'dotenv/config'

function exigir(nome) {
  const valor = process.env[nome]
  if (!valor) throw new Error(`Variável de ambiente ${nome} não configurada (veja .env.example)`)
  return valor
}

export const SUPABASE_URL = exigir('SUPABASE_URL')
export const SUPABASE_SERVICE_ROLE_KEY = exigir('SUPABASE_SERVICE_ROLE_KEY')
export const GROQ_API_KEY = exigir('GROQ_API_KEY')
