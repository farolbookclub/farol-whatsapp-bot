import { supabase } from './supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Liga o número de WhatsApp (jid) a uma inscrição aprovada, a partir do mesmo
// token usado no link "Minha inscrição" (manda "/start <token>" no privado).
// Link de uso único por inscrição: se já tiver outro jid vinculado, recusa.
export async function vincularConta(jid, token) {
  if (!UUID.test(token)) return null

  const { data: cadastro, error: erroCadastro } = await supabase
    .from('signups')
    .select('id, status, nome, apelido')
    .eq('confirmation_token', token)
    .maybeSingle()
  if (erroCadastro) console.error('vincularConta (buscar signup):', erroCadastro.message, erroCadastro.code)
  if (!cadastro) return { ok: false, texto: 'Esse link não é válido. Abra de novo a página Minha inscrição e use o botão de lá.' }
  if (cadastro.status !== 'aprovado') {
    return {
      ok: false,
      texto: cadastro.status === 'cancelado'
        ? 'Essa inscrição foi cancelada. Pra voltar, faça uma nova adesão pelo site do Farol.'
        : 'Sua inscrição ainda não foi liberada. Confirme seu e-mail e depois use o botão de novo.',
    }
  }

  const { data: jaVinculado } = await supabase.from('whatsapp_membros').select('jid').eq('signup_id', cadastro.id).maybeSingle()
  if (jaVinculado && jaVinculado.jid !== jid) {
    return { ok: false, texto: 'Esse link já foi usado por outro número. Se trocou de número, chame a Administração.' }
  }

  const { error } = await supabase
    .from('whatsapp_membros')
    .upsert({ jid, signup_id: cadastro.id, entrou_em: new Date().toISOString().slice(0, 10) }, { onConflict: 'jid' })
  if (error) throw error

  return { ok: true, apelido: cadastro.apelido || cadastro.nome }
}

// A inscrição aprovada ligada a esse jid (ou null).
export async function inscricaoDoJid(jid) {
  const { data } = await supabase
    .from('whatsapp_membros')
    .select('signups (status, apelido, nome)')
    .eq('jid', jid)
    .is('removido_em', null)
    .maybeSingle()
  const s = data?.signups
  return s?.status === 'aprovado' ? s : null
}
