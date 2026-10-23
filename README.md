# Faroleiro no WhatsApp

Bot do Farol Book Club pro WhatsApp (usa [Baileys](https://github.com/WhiskeySockets/Baileys), não é a API oficial — por isso precisa rodar sempre ligado, tipo no celular).

## Rodando no celular (Termux)

1. Instala F-Droid, Termux e Termux:Boot (veja instruções à parte).
2. Dentro do Termux:
   ```
   pkg update && pkg upgrade
   pkg install nodejs git termux-api
   git clone https://github.com/farolbookclub/farol-whatsapp-bot
   cd farol-whatsapp-bot
   npm install
   ```
3. Copia `.env.example` pra `.env` e preenche:
   - `SUPABASE_SERVICE_ROLE_KEY` — pega no painel do Supabase (Project Settings → API Keys → secret).
   - `GROQ_API_KEY` — a mesma chave já usada no bot do Telegram, ou gera uma nova em console.groq.com/keys.
   - `WHATSAPP_PHONE_NUMBER` — se o WhatsApp estiver no mesmo celular que roda o bot (não dá pra escanear QR da própria tela), preenche com o número do chip (DDI+DDD, só números, ex: `5511999999999`).
4. Roda:
   ```
   termux-wake-lock
   npm start
   ```
5. **Com `WHATSAPP_PHONE_NUMBER` preenchido:** aparece um código de 8 dígitos no terminal. No WhatsApp: **Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone** → digita o código.
   **Sem `WHATSAPP_PHONE_NUMBER`** (WhatsApp em outro aparelho): aparece um QR code — escaneia normalmente em **Aparelhos conectados → Conectar um aparelho**.
6. Pronto, fica rodando. Pra deixar persistente mesmo fechando o Termux, roda dentro de uma sessão `tmux` (`pkg install tmux`, depois `tmux new -s faroleiro`, roda o `npm start` lá dentro, e sai com `Ctrl+B` depois `D` sem matar a sessão).

## Configurando os grupos

Dentro de cada grupo do WhatsApp (Avisos, Bate-papo, Leitura do mês, Presencial), uma admin manda:

```
!configurar bate_papo
!configurar leitura
!configurar avisos
!configurar presencial
```

## Vinculando uma conta

No site, o link "Entrar no WhatsApp" abre uma conversa com o número do bot já preenchida com `/start <token>` (mesmo token da página Minha inscrição). A pessoa só precisa mandar a mensagem.

## Comandos

- `/resumo`, `/resumo_leitura`, `/resumo_avisos`, `/resumo_presencial` — dentro do grupo ou no privado.

## Se a internet cair

Mensagens perdidas durante a queda não tem como recuperar 100% (limitação do WhatsApp, não do bot). Se quiser cobrir o buraco manualmente: exporta a conversa do grupo (⋮ → Mais → Exportar conversa → sem mídia) e manda o `.txt` — dá pra importar na mão pro banco.
