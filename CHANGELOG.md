# Alterações desta revisão

## Funcionalidades corrigidas

- Exclusão permanente de visitas, inclusive canceladas, com verificação de propriedade e autorização de gerente.
- Fluxo de eventos conectado ao SQLite: solicitação do funcionário, consulta por perfil e decisão do gerente com justificativa.
- Fluxo de viagens conectado ao SQLite: formulário, custos estimados, comprovante opcional, listagem, aprovação e recusa.
- Fluxo de relatórios conectado ao SQLite: persistência, gastos, contatos e múltiplos anexos.
- Entrega de anexos por rota autenticada, com verificação de propriedade, MIME detectado, nome de armazenamento aleatório e diretório privado.
- APIs com respostas JSON e códigos HTTP para sessões ausentes, permissões insuficientes e decisões duplicadas.

## Telas conectadas a dados reais

- Dashboard do gerente e dashboard do funcionário.
- Calendário do funcionário e calendário resumido do gerente.
- Listagem da equipe cadastrada.
- Consolidação de estimativas de viagens e valores informados em relatórios.
- Telas de eventos, viagens e relatórios.

## Segurança e manutenção

- Inicialização idempotente das tabelas base e dos novos módulos.
- Configuração de caminho do banco e diretório de anexos por variáveis de ambiente.
- Segredo de sessão com mínimo de 32 caracteres.
- Cookie de sessão `secure` em produção.
- Credenciais reais removidas do pacote de entrega; usar `.env.example`.
- Scripts de criação de gerente e funcionário com entradas interativas e suporte a entrada por pipe.
- Testes automatizados de integração com banco temporário (`npm test`).

## Limitações conhecidas

- A validação visual pixel a pixel em navegador não foi concluída porque o navegador headless disponível no ambiente não iniciou corretamente. Sintaxe HTML/JS/CSS e referências locais foram verificadas.
- O sistema consolida estimativas de viagens e valores declarados em relatórios; ainda não existe módulo independente de contas pagas, reembolsos ou conciliação financeira.
- A tabela de usuários não possui campo de região; a tela de equipe agora apresenta os representantes cadastrados sem atribuir regiões não existentes no banco.
- Três imagens do pacote original estavam corrompidas; foram substituídas por placeholders nas páginas que as referenciavam.
