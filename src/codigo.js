import { supabase } from './supabase.js'
import { gruposParaEnviar, grupoTemMembro, gruposFaltandoTexto } from './guia.js'
import { enviarMsg } from './envio.js'
import { nomeExibicaoDoSignup } from './vinculo.js'
import { enviarCodigoEmDuasMensagens, concluirEntradaOficial } from './finalizacaoMembra.js'

// Confere se o código do site mudou (rotação automática semanal ou pedido
// manual) e ainda não foi postado no Avisos do WhatsApp; posta se precisar.
export async function checarCodigoPendente(sock) {
  const { data: config } = await supabase
    .from('bot_config')
    .select('codigo_atual, codigo_trocado_em, codigo_postado_whatsapp_em')
    .eq('id', 1)
    .single()
  if (!config?.codigo_atual || !config.codigo_trocado_em) return

  const jaPostado = config.codigo_postado_whatsapp_em && new Date(config.codigo_postado_whatsapp_em) >= new Date(config.codigo_trocado_em)
  if (jaPostado) return

  const { data: grupo } = await supabase.from('whatsapp_grupos').select('group_jid').eq('topico', 'avisos').eq('ativo', true).maybeSingle()
  if (!grupo) return

  await enviarCodigoEmDuasMensagens(sock, grupo.group_jid, config.codigo_atual, '🔑 Código do site de membras:')

  await supabase.from('bot_config').update({ codigo_postado_whatsapp_em: new Date().toISOString() }).eq('id', 1)
}

// Depois que ela está de fato em todos os grupos do formato dela (Avisos,
// Bate-papo, Leitura do mês, +Presencial se for o caso), manda a mensagem
// oficial de boas-vindas + código no privado — só 1 vez (codigo_enviado).
// Chamado toda vez que ela entra em mais um grupo. Enquanto ainda falta
// algum, guarda desde quando está incompleta (grupos_incompletos_desde) —
// é esse marcador que diz pra revisarMembrosIncompletos quem ela deve
// acompanhar. Sem essa marca, a varredura periódica nunca mexe em ninguém
// (importante: evita reprocessar/mandar mensagem pra gente antiga que
// nunca passou por aqui).
export async function checarEnviarCodigoSeCompleta(sock, jid, signupId, formato) {
  if (!signupId) return
  const { data: membro } = await supabase
    .from('whatsapp_membros')
    .select('codigo_enviado, grupos_incompletos_desde')
    .eq('jid', jid)
    .is('removido_em', null)
    .maybeSingle()
  if (!membro || membro.codigo_enviado) return

  const grupos = await gruposParaEnviar(formato)
  if (!grupos.length) return
  for (const g of grupos) {
    if (!(await grupoTemMembro(sock, g.group_jid, jid))) {
      if (!membro.grupos_incompletos_desde) {
        await supabase.from('whatsapp_membros').update({ grupos_incompletos_desde: new Date().toISOString() }).eq('jid', jid)
      }
      return // ainda falta algum
    }
  }

  await concluirEntradaOficial(sock, jid, signupId, formato)
}

// Alguém já integrante pede o código de novo (ex.: "não achei o código").
// Só manda se ela já estiver em todos os grupos obrigatórios do formato
// dela; senão, avisa o que ainda falta (com link).
export async function responderPedidoCodigo(sock, jid, signupId, formato) {
  if (!signupId) return
  const r = await gruposFaltandoTexto(sock, jid, formato)
  if (!r.configurado) {
    await enviarMsg(sock, jid, { text: 'Os grupos ainda não estão configurados. Chame a Administração 💖' })
    return
  }
  if (!r.completo) {
    await enviarMsg(sock, jid, { text: `Ainda falta você entrar em:\n\n${r.links}\npra você estar oficialmente no clube e receber o código 💖` })
    return
  }

  const { data: config } = await supabase.from('bot_config').select('codigo_atual').eq('id', 1).maybeSingle()
  if (!config?.codigo_atual) return

  try {
    await enviarCodigoEmDuasMensagens(sock, jid, config.codigo_atual, '🔑 Código do site de membras:')
    await supabase.from('whatsapp_membros').update({ codigo_enviado: true }).eq('jid', jid)
  } catch (erro) {
    console.error(`reenviar código ${jid}:`, erro)
  }
}

// Varredura periódica — SÓ mexe em quem já foi marcada como incompleta de
// verdade (grupos_incompletos_desde preenchido por checarEnviarCodigoSeCompleta,
// num evento real de entrada em grupo). Nunca varre quem não tem essa marca,
// pra não reprocessar/mandar mensagem indevida pra gente antiga. Pra cada
// uma marcada, confere de novo na hora:
//   - já completou tudo nesse meio-tempo? manda a mensagem oficial agora;
//   - já passou 1h desde que foi marcada e ainda não mandou lembrete?
//     manda o lembrete (1x só) com o link do que falta.
export async function revisarMembrosIncompletos(sock) {
  const { data: membros } = await supabase
    .from('whatsapp_membros')
    .select('jid, signup_id, grupos_incompletos_desde, lembrete_grupos_enviado_em, links_enviados_em, signups (apelido, nome, formato)')
    .is('removido_em', null)
    .eq('codigo_enviado', false)
    .not('grupos_incompletos_desde', 'is', null)
  if (!membros?.length) return

  const umaHoraAtras = Date.now() - 60 * 60 * 1000

  for (const m of membros) {
    const formato = m.signups?.formato
    if (!formato || !m.signup_id) continue
    try {
      const r = await gruposFaltandoTexto(sock, m.jid, formato)
      if (!r.configurado) continue

      if (r.completo) {
        await concluirEntradaOficial(sock, m.jid, m.signup_id, formato)
        continue
      }

      if (m.lembrete_grupos_enviado_em) continue // já lembrou, não repete
      if (new Date(m.grupos_incompletos_desde).getTime() > umaHoraAtras) continue // ainda não faz 1h

      const nome = await nomeExibicaoDoSignup(m.signup_id, m.signups?.apelido || m.signups?.nome || '')
      const prazo = m.links_enviados_em
        ? new Date(new Date(m.links_enviados_em).getTime() + 48 * 60 * 60 * 1000)
            .toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : null
      await enviarMsg(sock, m.jid, {
        text: `Oi, ${nome}! Passando para lembrar que ainda falta você entrar em:\n\n${r.links}\n` +
          (prazo ? `⏳ Os links valem até ${prazo}.` : '⏳ Os links valem por 48 horas.'),
      })
      await supabase.from('whatsapp_membros').update({ lembrete_grupos_enviado_em: new Date().toISOString() }).eq('jid', m.jid)
    } catch (erro) {
      console.error(`revisar membro incompleto ${m.jid}:`, erro)
    }
  }
}
