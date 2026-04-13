# Execucao 24/7 no Windows

Guia para manter frontend + servicos (WhatsApp, Telegram, Shopee, Mercado Livre) em execução continua com reinicio automatico após crash e após reboot do servidor.

## 1) Instalar dependencias

```powershell
npm install
```

## 2) Instalar PM2 global

```powershell
npm install -g pm2 pm2-windows-startup
```

## 3) Bootstrap de producao (build + start + save)

```powershell
npm run pm2:bootstrap
```

Esse comando:

- faz build do frontend + microservicos;
- sobe todos os processos do `ecosystem.config.cjs`;
- salva snapshot para restauração automatica.

## 4) Habilitar inicio automatico no boot do Windows

Abra PowerShell como administrador e rode:

```powershell
pm2-startup install
```

## 5) Validar stack após reinicio

Depois de reiniciar a maquina:

```powershell
pm2 list
pm2 logs --lines 100
```

Voce deve ver estes apps online:

- `autolinks-web`
- `autolinks-whatsapp`
- `autolinks-telegram`
- `autolinks-shopee`
- `autolinks-meli`
- `autolinks-dispatch-scheduler`
- `autolinks-health-guardian`

## Scheduler 24/7 sem depender da interface

Para o `autolinks-dispatch-scheduler` executar de forma realmente independente da UI, configure backend remoto e variaveis de ambiente:

- `SCHEDULER_MODE=remote`
- `SCHEDULER_RPC_BASE_URL=https://seu-backend`
- `SCHEDULER_RPC_TOKEN=seu-token`

Sem essas variaveis, o scheduler entra em fallback local e apenas informa a limitacao do modo baseado em navegador.

## 6) Health checks rapidos

```powershell
curl http://127.0.0.1:3011/health
curl http://127.0.0.1:3002/health
curl http://127.0.0.1:3003/health
curl http://127.0.0.1:3004/api/meli/health
```

## 7) Comandos operacionais

```powershell
npm run pm2:restart
npm run pm2:stop
npm run pm2:delete
npm run pm2:save
pm2 logs autolinks-health-guardian --lines 100
```

## Monitor de estabilidade continua

O processo `autolinks-health-guardian` monitora continuamente os 4 servicos por HTTP e reinicia o app PM2 correspondente quando ha falhas consecutivas.

Variaveis opcionais de ajuste:

- `HEALTHCHECK_INTERVAL_MS` (default `30000`)
- `HEALTHCHECK_TIMEOUT_MS` (default `6000`)
- `HEALTHCHECK_FAILS` (default `3`)
- `HEALTHCHECK_RESTART_COOLDOWN_MS` (default `120000`)
- `WA_HEALTH_URL`, `TG_HEALTH_URL`, `SHOPEE_HEALTH_URL`, `MELI_HEALTH_URL`

## Observacoes

- PM2 reinicia processos automaticamente em caso de crash.
- O `health-guardian` cobre casos em que o processo esta ativo mas sem responder corretamente.
- Rode `npm run pm2:bootstrap` após alteracoes de codigo para atualizar os artefatos de producao.
- Se faltar variavel de ambiente, o processo pode subir mas falhar funcionalmente; valide com `pm2 logs`.
