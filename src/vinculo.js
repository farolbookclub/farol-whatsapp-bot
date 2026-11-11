import { supabase } from './supabase.js'
import { avisarInstagramSaiu } from './instagramAviso.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Texto pra cada motivo de cancelamento possível (cancelado_motivo +, pra
// quebra_regra, o começo de cancelado_detalhe — que guarda o rótulo da
// regra escolhida no painel: "Ausência virtual", "3 encontros sem ir" etc.).
// outro_motivo, removida_adm_whatsapp e sem motivo registrado caem todos no
// genérico (fallback), de propósito.
function textoMotivoCancelamento(motivo, detalhe) {
  const d = detalhe || ''
  if (motivo === 'inatividade' || d.startsWith('Ausência virtual')) {
    return 'Sua inscrição foi cancelada por inatividade: foram 30 dias sem interagir no clube.'
  }
  if (d.startsWith('3 encontros sem ir')) {
    return 'Sua inscrição foi cancelada porque você faltou a 3 encontros presenciais seguidos.'
  }
  if (motivo === 'quebra_regra') {
    return 'Sua inscrição foi cancelada porque uma das regras do clube não foi cumprida.'
  }
  if (motivo === 'prazo_48h_nao_completou') {
    return 'Sua inscrição foi cancelada porque você não entrou em todos os grupos dentro das 48h.'
  }
  if (motivo === 'prazo_48h_nao_iniciou') {
    return 'Sua inscrição foi cancelada porque você não iniciou a conversa com o Faroleiro dentro das 48h após a aprovação.'
  }
  if (motivo === 'saida_voluntaria_grupo') {
    return 'Sua inscrição foi cancelada porque você saiu de um ou mais grupos do clube.'
  }
  if (motivo === 'saida_voluntaria') {
    return 'Sua inscrição foi cancelada a pedido, por saída voluntária.'
  }
  return 'Sua inscrição foi cancelada.'
}

// Quem aparece de verdade é sempre o "Nome ou apelido de exibição"
// (membras.nome_exibicao, igual no site) — nunca o apelido/nome crus do
// cadastro. fallback é usado só se ainda não tiver membra (ou nome_exibicao
// vazio) — ex.: no primeiro contato, antes do vínculo terminar.
export async function nomeExibicaoDoSignup(signupId, fallback) {
  if (!signupId) return fallback
  const { data } = await supabase.from('membras').select('nome_exibicao').eq('signup_id', signupId).maybeSingle()
  return data?.nome_exibicao || fallback
}

// Apresentação que ela já escreveu em "Minha inscrição" (no site), antes
// mesmo de entrar no grupo — pra incluir nas boas-vindas se tiver.
export async function apresentacaoDoSignup(signupId) {
  if (!signupId) return null
  const { data } = await supabase.from('membras').select('apresentacao').eq('signup_id', signupId).maybeSingle()
  return data?.apresentacao?.trim() || null
}

// membras.entrou_em é o que o painel admin usa pra mostrar "entrou no
// grupo" em Integrantes — é separado de whatsapp_membros.entrou_em (que só
// controla a regra de inatividade). Sem isso, a integrante aparece pra
// sempre como "ainda não entrou no grupo" mesmo já estando lá.
export async function marcarEntrouMembras(signupId) {
  const { error } = await supabase
    .from('membras')
    .update({ entrou_em: new Date().toISOString().slice(0, 10) })
    .eq('signup_id', signupId)
    .is('entrou_em', null)
  if (error) console.error('marcarEntrouMembras:', error.message)
}

// Liga o número de WhatsApp (jid) a uma inscrição aprovada, a partir do mesmo
// token usado no link "Minha inscrição" (manda "/start <token>" no privado).
// Link de uso único por inscrição: se já tiver outro jid vinculado, recusa.
export async function vincularConta(jid, token) {
  if (!UUID.test(token)) return null

  const { data: cadastro, error: erroCadastro } = await supabase
    .from('signups')
    .select('id, status, nome, apelido, formato, cancelado_motivo, cancelado_detalhe')
    .eq('confirmation_token', token)
    .maybeSingle()
  if (erroCadastro) console.error('vincularConta (buscar signup):', erroCadastro.message, erroCadastro.code)
  if (!cadastro) return { ok: false, texto: 'Link inválido. Abra *Minha inscrição* e use o botão de lá.' }
  if (cadastro.status !== 'aprovado') {
    return {
      ok: false,
      texto: cadastro.status === 'cancelado'
        ? `${textoMotivoCancelamento(cadastro.cancelado_motivo, cadastro.cancelado_detalhe)} Para voltar, faça uma nova adesão no site do Farol. A aprovação depende de vaga disponível.`
        : 'Sua inscrição ainda não foi liberada. Confirme seu e-mail e toque no botão de novo.',
    }
  }

  const { data: jaVinculado } = await supabase.from('whatsapp_membros').select('jid').eq('signup_id', cadastro.id).maybeSingle()
  if (jaVinculado && jaVinculado.jid !== jid) {
    return { ok: false, texto: 'Esse link já foi usado em outro número. Trocou de número? Fale com a Administração.' }
  }

  // removido_em explícito: se esse número já foi removido antes, o upsert
  // (por padrão só atualiza as colunas informadas) deixaria a data antiga
  // ali, e ela ficaria invisível pro bot pra sempre mesmo depois de vinculada de novo.
  const { error } = await supabase
    .from('whatsapp_membros')
    .upsert({ jid, signup_id: cadastro.id, entrou_em: new Date().toISOString().slice(0, 10), guia_etapa: 1, removido_em: null }, { onConflict: 'jid' })
  if (error) throw error
  await marcarEntrouMembras(cadastro.id)

  const apelido = await nomeExibicaoDoSignup(cadastro.id, cadastro.apelido || cadastro.nome)
  return { ok: true, apelido, formato: cadastro.formato }
}

export function normalizarNumero(numero) {
  const bruto = String(numero || '').trim()
  if (!bruto) return null
  const digitos = bruto.replace(/\D/g, '')
  if (!digitos) return null
  // Com "+": já tem DDI explícito, usa como está (não assume Brasil).
  if (bruto.startsWith('+')) return digitos
  if (digitos.length <= 11) return '55' + digitos // sem DDI: assume Brasil
  return digitos
}

// Plano B pra quem é adicionada na mão no grupo (sem passar pelo link/token):
// reconhece pelo número de WhatsApp que a pessoa informou na inscrição.
export async function vincularPorNumero(sock, jid) {
  const { data: candidatos } = await supabase
    .from('signups')
    .select('id, whatsapp, apelido, nome, formato')
    .eq('status', 'aprovado')
    .not('whatsapp', 'is', null)
  if (!candidatos?.length) return null

  const { data: existentes } = await supabase.from('whatsapp_membros').select('jid, signup_id').is('removido_em', null)
  const idsVinculados = new Set((existentes ?? []).map((v) => v.signup_id))
  if ((existentes ?? []).some((v) => v.jid === jid)) return null // já vinculada

  for (const c of candidatos) {
    if (idsVinculados.has(c.id)) continue
    const numero = normalizarNumero(c.whatsapp)
    if (!numero) continue
    try {
      const [resultado] = await sock.onWhatsApp(numero)
      if (resultado?.exists && (resultado.jid === jid || resultado.lid === jid)) {
        await supabase
          .from('whatsapp_membros')
          .upsert(
            { jid, signup_id: c.id, entrou_em: new Date().toISOString().slice(0, 10), guia_etapa: 1, ja_nos_grupos: true, removido_em: null },
            { onConflict: 'jid' },
          )
        await marcarEntrouMembras(c.id)
        return { ...c, apelido: await nomeExibicaoDoSignup(c.id, c.apelido || c.nome) }
      }
    } catch (erro) {
      console.error('vincularPorNumero:', erro)
    }
  }
  return null
}

// Marca que essa pessoa falou hoje (qualquer mensagem em qualquer grupo
// acompanhado conta), pra regra de inatividade. Não faz nada se não estiver
// vinculada.
export async function registrarInteracao(jid) {
  const { error } = await supabase
    .from('whatsapp_membros')
    .update({ ultima_interacao: new Date().toISOString().slice(0, 10) })
    .eq('jid', jid)
    .is('removido_em', null)
  if (error) console.error('registrarInteracao:', error.message)
}

// Saiu/foi removida de todos os grupos (ou do Avisos, o "grupo principal"):
// cancela a inscrição (libera a vaga) e desfaz o vínculo. Espelha o que o
// Telegram já fazia (saidaDoGrupo) — lá só existe 1 grupo, aqui são vários.
export async function desvincularECancelar(sock, jid, signupId, motivo) {
  await supabase
    .from('whatsapp_membros')
    .update({ removido_em: new Date().toISOString().slice(0, 10), signup_id: null, lembrete_ref: null })
    .eq('jid', jid)
  if (!signupId) return
  await supabase
    .from('signups')
    .update({ status: 'cancelado', cancelado_motivo: motivo, cancelado_em: new Date().toISOString() })
    .eq('id', signupId)
    .neq('status', 'cancelado')
  await avisarInstagramSaiu(sock, signupId)
}

// A inscrição aprovada ligada a esse jid (ou null). "apelido" já vem
// resolvido pro nome de exibição (membras.nome_exibicao) — quem usar esse
// campo já pega o nome certo sem precisar saber dessa regra.
export async function inscricaoDoJid(jid) {
  const { data } = await supabase
    .from('whatsapp_membros')
    .select('signup_id, signups (status, apelido, nome, formato, revisao_manual)')
    .eq('jid', jid)
    .is('removido_em', null)
    .maybeSingle()
  const s = data?.signups
  if (s?.status !== 'aprovado') return null
  return { ...s, signup_id: data.signup_id, apelido: await nomeExibicaoDoSignup(data.signup_id, s.apelido || s.nome) }
}
