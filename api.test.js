const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const cookieSignature = require('cookie-signature');

const projectDir = path.resolve(__dirname, '..');
const sessionSecret = 'believie-integration-test-secret-please-replace';
let temporaryDir;
let databasePath;
let uploadsDir;
let baseUrl;
let serverProcess;
let serverOutput = '';
let cookies = {};

function portaLivre() {
    return new Promise((resolve, reject) => {
        const servidor = net.createServer();
        servidor.once('error', reject);
        servidor.listen(0, '127.0.0.1', () => {
            const porta = servidor.address().port;
            servidor.close(() => resolve(porta));
        });
    });
}

function criarSessao(database, id, nome, email, tipo) {
    const sid = crypto.randomBytes(24).toString('hex');
    const sessao = {
        cookie: {
            originalMaxAge: 7 * 24 * 60 * 60 * 1000,
            expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            secure: false,
            httpOnly: true,
            path: '/',
            sameSite: 'lax',
        },
        usuario: { id, nome, email, tipo },
    };
    database.prepare('INSERT INTO sessoes_login (sid, sess, expires) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(sessao), Date.now() + 7 * 24 * 60 * 60 * 1000);
    return `bellievie.sid=s:${cookieSignature.sign(sid, sessionSecret)}`;
}

async function aguardarServidor() {
    for (let tentativa = 0; tentativa < 80; tentativa++) {
        try {
            const resposta = await fetch(`${baseUrl}/`);
            if (resposta.ok) return;
        } catch {
            // O processo ainda está iniciando.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (serverProcess && serverProcess.exitCode !== null) {
            throw new Error(`Servidor de teste encerrou antes de iniciar.\n${serverOutput}`);
        }
    }
    throw new Error(`Servidor de teste não iniciou a tempo.\n${serverOutput}`);
}

async function requisicao(url, { cookie, method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const resposta = await fetch(`${baseUrl}${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
    });
    const tipo = resposta.headers.get('content-type') || '';
    const dados = tipo.includes('application/json') ? await resposta.json() : await resposta.text();
    return { resposta, dados };
}

before(async () => {
    temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'believie-api-test-'));
    databasePath = path.join(temporaryDir, 'banco-teste.db');
    uploadsDir = path.join(temporaryDir, 'uploads');

    const database = new Database(databasePath);
    database.pragma('foreign_keys = ON');
    database.exec(`
        CREATE TABLE usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            senha TEXT NOT NULL,
            tipo TEXT NOT NULL DEFAULT 'funcionario'
                CHECK (tipo IN ('gerente', 'funcionario'))
        );

        INSERT INTO usuarios (id, nome, email, senha, tipo) VALUES
            (1, 'Gerente de Teste', 'gerente@example.test', 'hash-teste', 'gerente'),
            (2, 'Funcionário A', 'funcionario.a@example.test', 'hash-teste', 'funcionario'),
            (3, 'Funcionário B', 'funcionario.b@example.test', 'hash-teste', 'funcionario');

        CREATE TABLE visitas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            titulo TEXT NOT NULL,
            data_visita TEXT NOT NULL,
            horario TEXT NOT NULL,
            endereco TEXT NOT NULL,
            nome_contato TEXT NOT NULL,
            empresa TEXT NOT NULL,
            telefone TEXT,
            finalidade TEXT NOT NULL,
            observacoes TEXT,
            status TEXT NOT NULL DEFAULT 'agendada'
                CHECK (status IN ('agendada', 'realizada', 'cancelada')),
            usuario_id INTEGER NOT NULL,
            criada_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            atualizada_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
        );
    `);
    database.close();

    const port = await portaLivre();
    baseUrl = `http://127.0.0.1:${port}`;
    serverProcess = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
        cwd: projectDir,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(port),
            SESSION_SECRET: sessionSecret,
            EMAIL_USER: 'test@example.invalid',
            EMAIL_PASS: 'not-a-real-password',
            BELIEVIE_DB_PATH: databasePath,
            BELIEVIE_UPLOADS_DIR: uploadsDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProcess.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
    serverProcess.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

    await aguardarServidor();

    const databaseWithSessions = new Database(databasePath);
    cookies.gerente = criarSessao(databaseWithSessions, 1, 'Gerente de Teste', 'gerente@example.test', 'gerente');
    cookies.funcionarioA = criarSessao(databaseWithSessions, 2, 'Funcionário A', 'funcionario.a@example.test', 'funcionario');
    cookies.funcionarioB = criarSessao(databaseWithSessions, 3, 'Funcionário B', 'funcionario.b@example.test', 'funcionario');
    databaseWithSessions.close();
});

after(async () => {
    if (serverProcess && serverProcess.exitCode === null) {
        serverProcess.kill('SIGTERM');
        await new Promise((resolve) => {
            const timeout = setTimeout(resolve, 3000);
            serverProcess.once('exit', () => { clearTimeout(timeout); resolve(); });
        });
    }
    if (temporaryDir) fs.rmSync(temporaryDir, { recursive: true, force: true });
});

test('integração das APIs da Believie', async (t) => {
    await t.test('APIs exigem sessão e respondem JSON', async () => {
        const { resposta, dados } = await requisicao('/api/eventos');
        assert.equal(resposta.status, 401);
        assert.equal(typeof dados.erro, 'string');
    });

    await t.test('visitas: propriedade, cancelamento e exclusão', async () => {
        const payload = {
            titulo: 'Visita de teste',
            data_visita: '2026-12-10',
            horario: '10:00',
            endereco: 'Rua de Teste, 100',
            nome_contato: 'Contato de Teste',
            empresa: 'Empresa de Teste',
            telefone: '',
            finalidade: 'Teste automatizado',
            observacoes: '',
        };
        const criadaA = await requisicao('/api/visitas', { cookie: cookies.funcionarioA, method: 'POST', body: payload });
        assert.equal(criadaA.resposta.status, 201);
        const idA = criadaA.dados.id;

        const tentativaB = await requisicao(`/api/visitas/${idA}`, { cookie: cookies.funcionarioB, method: 'DELETE' });
        assert.equal(tentativaB.resposta.status, 404);

        const cancelada = await requisicao(`/api/visitas/${idA}/cancelar`, { cookie: cookies.funcionarioA, method: 'PATCH' });
        assert.equal(cancelada.resposta.status, 200);
        const excluidaA = await requisicao(`/api/visitas/${idA}`, { cookie: cookies.funcionarioA, method: 'DELETE' });
        assert.equal(excluidaA.resposta.status, 200);

        const criadaB = await requisicao('/api/visitas', { cookie: cookies.funcionarioB, method: 'POST', body: payload });
        assert.equal(criadaB.resposta.status, 201);
        const excluidaGerente = await requisicao(`/api/visitas/${criadaB.dados.id}`, { cookie: cookies.gerente, method: 'DELETE' });
        assert.equal(excluidaGerente.resposta.status, 200);
    });

    await t.test('eventos: envio, isolamento entre funcionários e decisão', async () => {
        const criada = await requisicao('/api/eventos', {
            cookie: cookies.funcionarioA,
            method: 'POST',
            body: {
                titulo: 'Evento de Teste',
                data_evento: '2026-12-15',
                horario: '14:30',
                local: 'Curitiba',
                descricao: 'Evento de integração automatizada',
            },
        });
        assert.equal(criada.resposta.status, 201);
        const id = criada.dados.id;

        const listaB = await requisicao('/api/eventos', { cookie: cookies.funcionarioB });
        assert.equal(listaB.resposta.status, 200);
        assert.equal(listaB.dados.length, 0);

        const decisaoFuncionario = await requisicao(`/api/eventos/${id}/decisao`, {
            cookie: cookies.funcionarioA, method: 'PATCH', body: { decisao: 'aprovado' },
        });
        assert.equal(decisaoFuncionario.resposta.status, 403);

        const semJustificativa = await requisicao(`/api/eventos/${id}/decisao`, {
            cookie: cookies.gerente, method: 'PATCH', body: { decisao: 'reprovado' },
        });
        assert.equal(semJustificativa.resposta.status, 400);

        const decisao = await requisicao(`/api/eventos/${id}/decisao`, {
            cookie: cookies.gerente,
            method: 'PATCH',
            body: { decisao: 'reprovado', justificativa: 'Fora do planejamento.' },
        });
        assert.equal(decisao.resposta.status, 200);

        const duplicada = await requisicao(`/api/eventos/${id}/decisao`, {
            cookie: cookies.gerente, method: 'PATCH', body: { decisao: 'aprovado' },
        });
        assert.equal(duplicada.resposta.status, 409);

        const listaA = await requisicao('/api/eventos', { cookie: cookies.funcionarioA });
        assert.equal(listaA.dados[0].status_aprovacao, 'reprovado');
        assert.equal(listaA.dados[0].justificativa, 'Fora do planejamento.');
    });

    await t.test('viagens: validação, custos e aprovação', async () => {
        const invalida = await requisicao('/api/viagens', {
            cookie: cookies.funcionarioA,
            method: 'POST',
            body: {
                origem: 'Curitiba', destino: 'São Paulo', data_ida: '2026-12-10',
                data_volta: '2026-12-09', transporte: 'Aéreo', hospedagem: 'Não', motivo: 'Teste',
            },
        });
        assert.equal(invalida.resposta.status, 400);

        const criada = await requisicao('/api/viagens', {
            cookie: cookies.funcionarioA,
            method: 'POST',
            body: {
                origem: 'Curitiba', destino: 'São Paulo', data_ida: '2026-12-10',
                data_volta: '2026-12-12', transporte: 'Aéreo', hospedagem: 'Sim',
                motivo: 'Reunião comercial', observacoes: '',
                custo_passagem: 1200.50, custo_hospedagem: 450, custo_transporte_local: 150,
            },
        });
        assert.equal(criada.resposta.status, 201);
        const id = criada.dados.id;

        const aprovada = await requisicao(`/api/viagens/${id}/decisao`, {
            cookie: cookies.gerente, method: 'PATCH', body: { decisao: 'aprovada' },
        });
        assert.equal(aprovada.resposta.status, 200);

        const duplicada = await requisicao(`/api/viagens/${id}/decisao`, {
            cookie: cookies.gerente, method: 'PATCH', body: { decisao: 'recusada', justificativa: 'Teste' },
        });
        assert.equal(duplicada.resposta.status, 409);

        const lista = await requisicao('/api/viagens', { cookie: cookies.funcionarioA });
        assert.equal(lista.dados[0].status, 'aprovada');
        assert.equal(lista.dados[0].custo_total, 1800.5);
    });

    await t.test('relatórios: envio de arquivos e controle de acesso aos anexos', async () => {
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/8ioAAAAASUVORK5CYII=', 'base64');
        const pdf = Buffer.from('%PDF-1.4\n% teste\n%%EOF');
        const criada = await requisicao('/api/relatorios', {
            cookie: cookies.funcionarioA,
            method: 'POST',
            body: {
                nome_evento: 'Relatório de Teste',
                data_relatorio: '2026-11-20',
                evento_relacionado: 'Evento de teste',
                resumo: 'Resumo de teste automatizado.',
                gastos: 125.75,
                contatos: 4,
                acao_resultado: 'Resultado de teste.',
                anexos: [
                    { categoria: 'foto', nome: 'foto.png', tipoMime: 'image/png', conteudoBase64: png.toString('base64') },
                    { categoria: 'anexo', nome: 'comprovante.pdf', tipoMime: 'application/pdf', conteudoBase64: pdf.toString('base64') },
                ],
            },
        });
        assert.equal(criada.resposta.status, 201);

        const relatorios = await requisicao('/api/relatorios', { cookie: cookies.gerente });
        assert.equal(relatorios.resposta.status, 200);
        const relatorio = relatorios.dados.find((item) => item.id === criada.dados.id);
        assert.ok(relatorio);
        assert.equal(relatorio.anexos.length, 2);

        const anexoId = relatorio.anexos[0].id;
        const abertoPeloDono = await fetch(`${baseUrl}/api/anexos/${anexoId}`, { headers: { Cookie: cookies.funcionarioA } });
        assert.equal(abertoPeloDono.status, 200);
        assert.equal(abertoPeloDono.headers.get('content-type'), 'image/png');

        const bloqueado = await requisicao(`/api/anexos/${anexoId}`, { cookie: cookies.funcionarioB });
        assert.equal(bloqueado.resposta.status, 404);

        const abertoPeloGerente = await fetch(`${baseUrl}/api/anexos/${anexoId}`, { headers: { Cookie: cookies.gerente } });
        assert.equal(abertoPeloGerente.status, 200);

        const database = new Database(databasePath, { readonly: true });
        const nomeArmazenado = database.prepare('SELECT nome_armazenado FROM anexos WHERE id = ?').get(anexoId).nome_armazenado;
        database.close();
        const acessoDireto = await fetch(`${baseUrl}/uploads/${nomeArmazenado}`);
        assert.equal(acessoDireto.status, 404);

        const muitosArquivos = await requisicao('/api/relatorios', {
            cookie: cookies.funcionarioA,
            method: 'POST',
            body: {
                nome_evento: 'Relatório inválido', data_relatorio: '2026-11-20', resumo: 'Teste',
                anexos: Array.from({ length: 6 }, (_, indice) => ({
                    categoria: 'anexo', nome: `${indice}.png`, tipoMime: 'image/png', conteudoBase64: png.toString('base64'),
                })),
            },
        });
        assert.equal(muitosArquivos.resposta.status, 400);

        const arquivoGrande = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.alloc(5 * 1024 * 1024),
        ]);
        const acimaDoLimite = await requisicao('/api/relatorios', {
            cookie: cookies.funcionarioA,
            method: 'POST',
            body: {
                nome_evento: 'Relatório com arquivo grande',
                data_relatorio: '2026-11-20',
                resumo: 'Teste de limite de tamanho.',
                gastos: 0,
                contatos: 0,
                anexos: [{ categoria: 'anexo', nome: 'grande.png', tipoMime: 'image/png', conteudoBase64: arquivoGrande.toString('base64') }],
            },
        });
        assert.equal(acimaDoLimite.resposta.status, 400);
    });

    await t.test('equipe, gastos, calendário e páginas respeitam os perfis', async () => {
        const equipe = await requisicao('/api/equipe', { cookie: cookies.gerente });
        assert.equal(equipe.resposta.status, 200);
        assert.equal(equipe.dados.total, 2);

        const equipeBloqueada = await requisicao('/api/equipe', { cookie: cookies.funcionarioA });
        assert.equal(equipeBloqueada.resposta.status, 403);

        const gastos = await requisicao('/api/gastos', { cookie: cookies.gerente });
        assert.equal(gastos.resposta.status, 200);
        assert.ok(gastos.dados.some((item) => item.tipo === 'viagem'));
        assert.ok(gastos.dados.some((item) => item.tipo === 'relatorio'));
        const gastosBloqueados = await requisicao('/api/gastos', { cookie: cookies.funcionarioA });
        assert.equal(gastosBloqueados.resposta.status, 403);

        const calendarioFuncionarioB = await requisicao('/api/calendario', { cookie: cookies.funcionarioB });
        assert.equal(calendarioFuncionarioB.resposta.status, 200);
        assert.equal(calendarioFuncionarioB.dados.length, 0);

        const calendario = await requisicao('/api/calendario', { cookie: cookies.gerente });
        assert.equal(calendario.resposta.status, 200);
        assert.ok(calendario.dados.some((item) => item.tipo === 'evento'));
        assert.ok(calendario.dados.some((item) => item.tipo === 'viagem'));

        const paginaGerente = await fetch(`${baseUrl}/Gerente/Dashboard.html`, { headers: { Cookie: cookies.gerente } });
        assert.equal(paginaGerente.status, 200);
        const gerenteBloqueado = await fetch(`${baseUrl}/Gerente/Dashboard.html`, { headers: { Cookie: cookies.funcionarioA }, redirect: 'manual' });
        assert.equal(gerenteBloqueado.status, 403);
        const paginaFuncionario = await fetch(`${baseUrl}/Usuarios/dashboarda.html`, { headers: { Cookie: cookies.funcionarioA } });
        assert.equal(paginaFuncionario.status, 200);
        const funcionarioBloqueado = await fetch(`${baseUrl}/Usuarios/dashboarda.html`, { headers: { Cookie: cookies.gerente }, redirect: 'manual' });
        assert.equal(funcionarioBloqueado.status, 403);
    });
});
