# Bellievie

Sistema interno para organização de representantes, visitas, eventos, viagens e relatórios.

## Requisitos

- Node.js 18 ou superior.
- npm.
- Conta de e-mail com senha de aplicativo SMTP para envio dos códigos de verificação.

## Instalação

1. Instale as dependências:

   ```bash
   npm ci
   ```

2. Copie `.env.example` para `.env`.
3. Preencha `EMAIL_USER` e `EMAIL_PASS` com as credenciais SMTP da conta utilizada pelo sistema.
4. Gere um segredo de sessão novo e aleatório com pelo menos 32 caracteres. Exemplo:

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   Coloque o resultado em `SESSION_SECRET`. Não reutilize o segredo de exemplo.

5. Cadastre o primeiro gerente:

   ```bash
   node criar_gerente.js
   ```

6. Inicie o sistema:

   ```bash
   npm start
   ```

O servidor cria automaticamente as tabelas de usuários, visitas, eventos, viagens, relatórios, anexos e sessões quando elas ainda não existem. Para cadastrar representantes adicionais, execute `node criar_funcionario.js`.

## Testes automatizados

Execute:

```bash
npm test
```

A suíte usa um banco SQLite temporário, sessões fictícias e uma pasta temporária de anexos. Ela não altera o banco de produção.

## Armazenamento de anexos

Os anexos não são publicados pela pasta estática do site. O acesso ocorre pela rota autenticada `/api/anexos/:id`, que verifica se o usuário é gerente ou proprietário do registro.

- Formatos aceitos: PDF, JPG/JPEG, PNG e WEBP.
- Limite por arquivo: 5 MB.
- Limite total por relatório: 10 MB.
- Até 5 arquivos por relatório.
- Os arquivos são armazenados em `uploads/`, fora da pasta pública `tcc-main/`.

O envio utiliza JSON com conteúdo Base64 e validação do conteúdo binário, do MIME detectado e do tamanho. Essa implementação evita depender de um parser multipart adicional.

## Perfis e permissões

- Funcionários acessam somente seus próprios eventos, viagens, relatórios e visitas.
- Gerentes consultam os registros de todos os funcionários e podem aprovar ou recusar eventos e viagens.
- A exclusão de visitas é permitida ao gerente e ao funcionário proprietário do registro.

## Observações de segurança

- Nunca compartilhe o arquivo `.env`.
- Se credenciais reais foram incluídas em um pacote compartilhado, troque a senha de aplicativo do e-mail e gere um novo `SESSION_SECRET`.
- Em produção, publique o sistema somente por HTTPS; o cookie de sessão passa a usar `secure` quando `NODE_ENV=production`.
- Não execute `banco_topzao.sql`: é um script legado com comandos destrutivos e erro de sintaxe.
- `app.py` e `verificacao/verify.js` são componentes legados e não fazem parte do fluxo iniciado por `npm start`.

## Arquivos visuais herdados

O pacote de origem contém três imagens corrompidas (`Frasco.jpg`, `abstrato-bellievie.jpg` e `image-removebg-preview.png`). As referências quebradas foram substituídas por espaços reservados nas páginas afetadas. Para restaurar as fotografias dos produtos, será necessário reenviar os arquivos originais válidos.
