# Atlas MVP

**Status atual** · MVP local validado no Windows. O Atlas recebeu respostas reais do Codex, retomou uma conversa após reiniciar a ponte e registrou aprovações e recusas reais.

O Atlas será uma interface de uso pessoal para o Codex no Windows. O primeiro objetivo é abrir uma conversa pelo Atlas, acompanhar a resposta e decidir sobre pedidos de aprovação dentro do chat. Ao reabrir o Atlas, deve ser possível retomar a conversa e consultar as decisões registradas.

## Decisões

| Tema | Decisão |
| --- | --- |
| Interface | Reaproveitar o HTML do protótipo, com a esfera, os projetos em órbita e o chat móvel e redimensionável. Substituir as conversas de exemplo e os cartões simulados por dados reais. |
| Integração | Usar a arquitetura do Codex WebUI como referência. Um serviço local inicia o Codex App Server e repassa ao navegador os eventos de conversa e aprovação. Node.js já está disponível no ambiente. |
| Conta | Usar o login do ChatGPT gerenciado pelo Codex. O uso segue o acesso e os limites do plano para o Codex. |
| Conversas | Usar as conversas acessíveis ao App Server. Verificar quais conversas já existentes no Codex podem ser listadas e retomadas no Windows. |
| Aprovações | Mostrar o pedido na conversa que o originou. Guardar a decisão e o estado da ação, com dados suficientes para consultar o que foi pedido e decidido após reiniciar o Atlas. |
| Execução | Rodar apenas na máquina local. Usar o projeto aberto como diretório de trabalho e manter a política de permissões do Codex. |

O MVP cobre conversa, histórico e aprovações do Codex. Voz real, integração com o Artha Tasks, acesso remoto e suporte a outros provedores ficam para etapas futuras.

## Acompanhamento

| Estado | Marco | Como validar |
| --- | --- | --- |
| Concluído | Definir o escopo e identificar o HTML base | O protótipo contém a navegação orbital, o histórico e os estados de aprovação que guiam a interface. |
| Concluído | Verificar o ambiente local | Node.js 20 e o executável do app oficial do Codex disponíveis. O Atlas selecionou automaticamente esse executável numa inicialização sem configuração manual. |
| Concluído | Conectar ao App Server | O Atlas inicializou o servidor no Windows, confirmou a autenticação pelo ChatGPT e recebeu a lista de conversas. |
| Concluído | Receber a primeira resposta real no Atlas | O executável do app oficial respondeu com GPT‑6.2 em tempo real usando o login do ChatGPT. A versão antiga que estava no PATH havia recusado os modelos. |
| Concluído | Carregar e retomar conversas | Após reiniciar a ponte, o Codex recuperou o contexto do turno anterior na mesma conversa e manteve sua pasta de trabalho. A seleção e a recarga da tela foram testadas no Chrome com dados simulados. |
| Concluído | Ligar aprovações e histórico | A aprovação permitiu a ação de teste uma vez. A recusa impediu a ação. As duas decisões e seus resultados foram recuperados após reiniciar o Atlas. Os botões foram testados no Chrome com dados simulados. |
| Concluído | Validar operação local | Inicialização e reinício confirmados no Windows. Reconexão, aviso de limite e recuperação após gravação interrompida foram testados com dados simulados. Instruções disponíveis no README. |

**Estimativa inicial de implementação** · 1 a 2 dias úteis para a primeira conversa real e 4 a 7 dias úteis no total. Todos os marcos acima já foram validados.

Atualizar o quadro ao concluir cada marco e registrar aqui qualquer mudança de escopo ou decisão que afete o uso do Atlas.

## Referências

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Autenticação do Codex](https://learn.chatgpt.com/docs/auth)
- [Codex WebUI e licença MIT](https://github.com/lezi-fun/codex-webui)
