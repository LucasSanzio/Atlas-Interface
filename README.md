# Atlas

Interface local para conversar com o Codex, retomar conversas e decidir sobre pedidos de aprovação. O aplicativo reaproveita o protótipo orbital do Atlas e usa o Codex App Server. [Referência de arquitetura do Codex WebUI](https://github.com/lezi-fun/codex-webui)

## Abrir no Windows

1. Tenha Node.js 20 ou mais recente e entre no Codex com sua conta do ChatGPT. O Atlas usa automaticamente o executável incluído no app oficial do Codex para Windows. Em uma instalação independente, ele usa o `codex` disponível no terminal.
2. Na pasta do Atlas, rode `npm start`. O aplicativo usa apenas bibliotecas incluídas no Node.js.
3. Abra [Atlas no navegador](http://127.0.0.1:8899/). Use **Abrir chat** para começar e **Histórico** para selecionar uma conversa que o App Server consegue acessar.
4. Use `Ctrl+C` no terminal para encerrar o serviço.

O Codex aplica o acesso e os limites do plano. A interface mostra os pedidos de aprovação da sessão. As decisões tomadas no Atlas ficam na pasta local `.atlas`, e o histórico de mensagens é mantido pelo Codex.

No Windows testado, a versão do Codex disponível no PATH era antiga. A versão incluída no aplicativo oficial respondeu em tempo real usando a conta do ChatGPT. Para escolher outro executável, defina `ATLAS_CODEX` com o caminho completo antes de iniciar o Atlas.

Se a porta padrão estiver em uso, defina `$env:ATLAS_PORT = '8900'` antes de iniciar e use a nova porta no navegador.

## Projetos

Use **Configurações** para escolher os projetos que aparecem como bolinhas na tela inicial. A seleção fica salva no navegador. O Atlas começa com os três primeiros projetos da lista do Codex.

Clique em uma bolinha para abrir o histórico daquele projeto. O botão **Projetos** dá acesso ao catálogo completo. O histórico inclui conversas vinculadas pelo Codex e conversas sem vínculo cujo diretório de trabalho corresponde a uma pasta cadastrada no projeto. Conversas arquivadas ficam disponíveis para leitura.

O chat comporta duas abas de conversa. Para abrir uma terceira, feche uma das abas. Ao navegar pela esfera, clique no nome em destaque para abrir a conversa escolhida.

## Andamento

Abra o [painel do MVP](./ATLAS-MVP.html) para consultar as decisões e os marcos de validação.
