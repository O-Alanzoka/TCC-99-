require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const session = require("express-session");
const nodemailer = require("nodemailer");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;

// ========================================
// LIMITADOR DE TENTATIVAS DE LOGIN
// ========================================

const intervaloLogin = 10_000; // 10 segundos
const bloqueiosLogin = new Map();

const caminhoBanco = process.env.BELIEVIE_DB_PATH
    ? path.resolve(process.env.BELIEVIE_DB_PATH)
    : path.join(__dirname, "tcc-main", "banco.db");
fs.mkdirSync(path.dirname(caminhoBanco), { recursive: true });

if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    throw new Error("Configure EMAIL_USER e EMAIL_PASS no arquivo .env.");
}

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error("Configure SESSION_SECRET no .env com pelo menos 32 caracteres aleatórios.");
}

const banco = new Database(caminhoBanco);
banco.pragma("foreign_keys = ON");

// ========================================
// ESTRUTURA BASE DO BANCO
// ========================================

banco.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        senha TEXT NOT NULL,
        tipo TEXT NOT NULL DEFAULT 'funcionario'
            CHECK (tipo IN ('gerente', 'funcionario'))
    );

    CREATE TABLE IF NOT EXISTS visitas (
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

    CREATE INDEX IF NOT EXISTS idx_visitas_usuario ON visitas(usuario_id);
    CREATE INDEX IF NOT EXISTS idx_visitas_data ON visitas(data_visita);
`);

/*
 * TABELA DE EVENTOS
 * Armazena as solicitações enviadas pelos representantes
 * e as decisões registradas pelo gerente.
 */
banco.exec(`
    CREATE TABLE IF NOT EXISTS eventos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        titulo TEXT NOT NULL,
        data_evento TEXT NOT NULL,
        horario TEXT,
        local TEXT NOT NULL,
        descricao TEXT,
        status_aprovacao TEXT NOT NULL DEFAULT 'pendente'
            CHECK (status_aprovacao IN ('pendente', 'aprovado', 'reprovado')),
        justificativa TEXT,
        usuario_id INTEGER NOT NULL,
        criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        atualizado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    );

    CREATE INDEX IF NOT EXISTS idx_eventos_usuario
    ON eventos(usuario_id);

    CREATE INDEX IF NOT EXISTS idx_eventos_data
    ON eventos(data_evento);

    CREATE INDEX IF NOT EXISTS idx_eventos_status
    ON eventos(status_aprovacao);
`);

// ========================================
// TABELAS DE VIAGENS, RELATÓRIOS E ANEXOS
// ========================================

banco.exec(`
    CREATE TABLE IF NOT EXISTS viagens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        origem TEXT NOT NULL,
        destino TEXT NOT NULL,
        data_ida TEXT NOT NULL,
        data_volta TEXT,
        transporte TEXT NOT NULL,
        hospedagem TEXT NOT NULL DEFAULT 'Não',
        motivo TEXT NOT NULL,
        observacoes TEXT,
        custo_passagem REAL NOT NULL DEFAULT 0 CHECK (custo_passagem >= 0),
        custo_hospedagem REAL NOT NULL DEFAULT 0 CHECK (custo_hospedagem >= 0),
        custo_transporte_local REAL NOT NULL DEFAULT 0 CHECK (custo_transporte_local >= 0),
        status TEXT NOT NULL DEFAULT 'pendente'
            CHECK (status IN ('pendente', 'aprovada', 'recusada')),
        justificativa TEXT,
        usuario_id INTEGER NOT NULL,
        criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        atualizado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    );

    CREATE INDEX IF NOT EXISTS idx_viagens_usuario ON viagens(usuario_id);
    CREATE INDEX IF NOT EXISTS idx_viagens_status ON viagens(status);
    CREATE INDEX IF NOT EXISTS idx_viagens_data_ida ON viagens(data_ida);

    CREATE TABLE IF NOT EXISTS relatorios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome_evento TEXT NOT NULL,
        data_relatorio TEXT NOT NULL,
        evento_relacionado TEXT,
        resumo TEXT NOT NULL,
        gastos REAL NOT NULL DEFAULT 0 CHECK (gastos >= 0),
        contatos INTEGER NOT NULL DEFAULT 0 CHECK (contatos >= 0),
        acao_resultado TEXT,
        usuario_id INTEGER NOT NULL,
        criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    );

    CREATE INDEX IF NOT EXISTS idx_relatorios_usuario ON relatorios(usuario_id);
    CREATE INDEX IF NOT EXISTS idx_relatorios_data ON relatorios(data_relatorio);

    CREATE TABLE IF NOT EXISTS anexos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entidade_tipo TEXT NOT NULL CHECK (entidade_tipo IN ('viagem', 'relatorio')),
        entidade_id INTEGER NOT NULL,
        nome_original TEXT NOT NULL,
        categoria TEXT NOT NULL DEFAULT 'anexo'
            CHECK (categoria IN ('foto', 'anexo', 'comprovante')),
        nome_armazenado TEXT NOT NULL UNIQUE,
        tipo_mime TEXT NOT NULL,
        tamanho INTEGER NOT NULL CHECK (tamanho > 0),
        criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_anexos_entidade
    ON anexos(entidade_tipo, entidade_id);
`);

const colunasAnexos = banco.prepare("PRAGMA table_info(anexos)").all().map((coluna) => coluna.name);
if (!colunasAnexos.includes("categoria")) {
    banco.exec(`ALTER TABLE anexos ADD COLUMN categoria TEXT NOT NULL DEFAULT 'anexo'`);
}

const diretorioUploads = process.env.BELIEVIE_UPLOADS_DIR
    ? path.resolve(process.env.BELIEVIE_UPLOADS_DIR)
    : path.join(__dirname, "uploads");
fs.mkdirSync(diretorioUploads, { recursive: true, mode: 0o700 });

// ========================================
// ARMAZENAMENTO PERSISTENTE DAS SESSÕES
// ========================================

const prazoSessao = 7 * 24 * 60 * 60 * 1000;

banco.exec(`
    CREATE TABLE IF NOT EXISTS sessoes_login (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessoes_login_expires
    ON sessoes_login(expires);
`);

class SQLiteSessionStore extends session.Store {
    constructor(database) {
        super();
        this.banco = database;
    }

    get(sid, callback) {
        try {
            const agora = Date.now();

            const registro = this.banco
                .prepare(
                    `
                    SELECT sess, expires
                    FROM sessoes_login
                    WHERE sid = ?
                `,
                )
                .get(sid);

            if (!registro) {
                return callback(null, null);
            }

            if (registro.expires <= agora) {
                this.banco.prepare("DELETE FROM sessoes_login WHERE sid = ?").run(sid);

                return callback(null, null);
            }

            const sessao = JSON.parse(registro.sess);
            callback(null, sessao);
        } catch (erro) {
            callback(erro);
        }
    }

    set(sid, sessao, callback = () => {}) {
        try {
            const validade =
                sessao.cookie && sessao.cookie.expires ?
                new Date(sessao.cookie.expires).getTime() :
                Date.now() +
                ((sessao.cookie && sessao.cookie.maxAge) || prazoSessao);

            this.banco
                .prepare(
                    `
                    INSERT INTO sessoes_login (sid, sess, expires)
                    VALUES (?, ?, ?)
                    ON CONFLICT(sid) DO UPDATE SET
                        sess = excluded.sess,
                        expires = excluded.expires
                `,
                )
                .run(sid, JSON.stringify(sessao), validade);

            callback(null);
        } catch (erro) {
            callback(erro);
        }
    }

    destroy(sid, callback = () => {}) {
        try {
            this.banco.prepare("DELETE FROM sessoes_login WHERE sid = ?").run(sid);

            callback(null);
        } catch (erro) {
            callback(erro);
        }
    }

    touch(sid, sessao, callback = () => {}) {
        try {
            const validade =
                sessao.cookie && sessao.cookie.expires ?
                new Date(sessao.cookie.expires).getTime() :
                Date.now() +
                ((sessao.cookie && sessao.cookie.maxAge) || prazoSessao);

            this.banco
                .prepare(
                    `
                    UPDATE sessoes_login
                    SET sess = ?, expires = ?
                    WHERE sid = ?
                `,
                )
                .run(JSON.stringify(sessao), validade, sid);

            callback(null);
        } catch (erro) {
            callback(erro);
        }
    }
}

const armazenamentoSessoes = new SQLiteSessionStore(banco);

// ========================================
// HASH E VERIFICAÇÃO DAS SENHAS
// ========================================

function criarHashSenha(senha) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(senha, salt, 64).toString("hex");

    return `scrypt$${salt}$${hash}`;
}

function verificarSenha(senhaInformada, senhaBanco) {
    if (typeof senhaBanco !== "string") return false;

    if (senhaBanco.startsWith("scrypt$")) {
        const partes = senhaBanco.split("$");

        if (partes.length !== 3) return false;

        const [, salt, hashSalvo] = partes;

        try {
            const hashCalculado = crypto.scryptSync(senhaInformada, salt, 64);

            const hashEsperado = Buffer.from(hashSalvo, "hex");

            return (
                hashCalculado.length === hashEsperado.length &&
                crypto.timingSafeEqual(hashCalculado, hashEsperado)
            );
        } catch {
            return false;
        }
    }

    // Compatibilidade temporária com senhas antigas.
    return senhaInformada === senhaBanco;
}

// ========================================
// ENVIO DE E-MAILS
// ========================================

const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    family: 4,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

if (process.env.NODE_ENV !== "test") {
    transporter.verify((erro) => {
        if (erro) {
            console.error("Erro na conexão SMTP:", erro.message);
        } else {
            console.log("Conexão SMTP funcionando!");
        }
    });
}

// ========================================
// MIDDLEWARES
// ========================================

app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use((req, res, next) => {
    const rotaComUpload = req.path === "/api/viagens" || req.path === "/api/relatorios";
    const limite = rotaComUpload ? "16mb" : "100kb";
    express.json({ limit: limite })(req, res, next);
});

// ========================================
// CONFIGURAÇÃO DA SESSÃO
// ========================================

if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
}

app.use(
    session({
        name: "bellievie.sid",
        secret: process.env.SESSION_SECRET,
        store: armazenamentoSessoes,
        resave: false,
        saveUninitialized: false,
        rolling: true,
        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            maxAge: prazoSessao,
        },
    }),
);

// ========================================
// PROTEÇÃO DE ARQUIVOS INTERNOS
// ========================================

app.use((req, res, next) => {
    const caminho = decodeURIComponent(req.path).toLowerCase();

    if (
        /\.(db|sqlite|sqlite3|sql|py|env)$/i.test(caminho) ||
        /(^|\/)(package\.json|package-lock\.json|server\.js)$/i.test(caminho)
    ) {
        return res.sendStatus(404);
    }

    next();
});

// ========================================
// ARQUIVOS PÚBLICOS
// ========================================

app.use(express.static(path.join(__dirname, "tcc-main")));
app.use("/verificacao", express.static(path.join(__dirname, "verificacao")));

// ========================================
// CONTROLE DE ACESSO
// ========================================

function exigirLogin(req, res, next) {
    if (!req.session.usuario) {
        return res.redirect("/login.html");
    }

    next();
}

function exigirLoginApi(req, res, next) {
    if (!req.session.usuario) {
        return res.status(401).json({
            erro: "Sua sessão expirou. Entre novamente no sistema.",
        });
    }

    next();
}

function exigirGerenteApi(req, res, next) {
    if (!req.session.usuario) {
        return res.status(401).json({
            erro: "Sua sessão expirou. Entre novamente no sistema.",
        });
    }

    if (req.session.usuario.tipo !== "gerente") {
        return res.status(403).json({
            erro: "Apenas gerentes podem realizar esta operação.",
        });
    }

    next();
}

function dataISOValida(valor) {
    if (typeof valor !== "string") return false;
    const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor);
    if (!partes) return false;
    const ano = Number(partes[1]);
    const mes = Number(partes[2]);
    const dia = Number(partes[3]);
    const data = new Date(Date.UTC(ano, mes - 1, dia));
    return data.getUTCFullYear() === ano &&
        data.getUTCMonth() === mes - 1 &&
        data.getUTCDate() === dia;
}

function valorMonetarioValido(valor) {
    if (valor === undefined || valor === null || valor === "") return 0;
    const numero = Number(valor);
    if (!Number.isFinite(numero) || numero < 0 || numero > 100000000) return null;
    return Math.round(numero * 100) / 100;
}

function prepararArquivoUpload(arquivo) {
    if (!arquivo || typeof arquivo !== "object") return null;

    const base64 = typeof arquivo.conteudoBase64 === "string" ? arquivo.conteudoBase64 : "";
    const limiteArquivo = 5 * 1024 * 1024;
    const limiteBase64 = Math.ceil(limiteArquivo / 3) * 4;

    if (!base64 || base64.length > limiteBase64) {
        throw new Error("Cada arquivo deve ter no máximo 5 MB e não pode estar vazio.");
    }

    if (base64.length % 4 !== 0) {
        throw new Error("O arquivo enviado está em um formato inválido.");
    }

    const semPreenchimento = base64.replace(/=+$/, "");
    const preenchimento = base64.slice(semPreenchimento.length);
    if (!/^[A-Za-z0-9+/]+$/.test(semPreenchimento) || !/^={0,2}$/.test(preenchimento)) {
        throw new Error("O arquivo enviado está em um formato inválido.");
    }

    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length || buffer.length > limiteArquivo || buffer.toString("base64") !== base64) {
        throw new Error("Cada arquivo deve ter no máximo 5 MB e não pode estar vazio.");
    }

    let tipoMime = null;
    let extensao = null;
    if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
        tipoMime = "application/pdf";
        extensao = ".pdf";
    } else if (
        buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
        tipoMime = "image/png";
        extensao = ".png";
    } else if (
        buffer.length >= 3 &&
        buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    ) {
        tipoMime = "image/jpeg";
        extensao = ".jpg";
    } else if (
        buffer.length >= 12 &&
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
        tipoMime = "image/webp";
        extensao = ".webp";
    } else {
        throw new Error("Tipo de arquivo não permitido. Envie PDF, JPG, PNG ou WEBP.");
    }

    const tipoDeclarado = String(arquivo.tipoMime || arquivo.tipo || "").toLowerCase();
    const tiposCompativeis = new Set([tipoMime, ...(tipoMime === "image/jpeg" ? ["image/jpg"] : [])]);
    if (tipoDeclarado && !tiposCompativeis.has(tipoDeclarado)) {
        throw new Error("O conteúdo do arquivo não corresponde ao tipo informado.");
    }

    const nomeOriginal = path.basename(String(arquivo.nome || "anexo").replace(/\\/g, "/"))
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .slice(0, 255) || "anexo";
    const nomeArmazenado = `${crypto.randomUUID()}${extensao}`;
    const caminho = path.join(diretorioUploads, nomeArmazenado);

    fs.writeFileSync(caminho, buffer, { flag: "wx", mode: 0o600 });

    return {
        nomeOriginal,
        nomeArmazenado,
        tipoMime,
        tamanho: buffer.length,
        caminho,
    };
}

function removerArquivosUpload(arquivos) {
    for (const arquivo of arquivos) {
        if (arquivo && arquivo.caminho) {
            try {
                fs.unlinkSync(arquivo.caminho);
            } catch (erro) {
                if (erro.code !== "ENOENT") {
                    console.error("Não foi possível remover arquivo temporário:", erro.message);
                }
            }
        }
    }
}

function registrarAnexo(entidadeTipo, entidadeId, arquivo, categoria = "anexo") {
    return banco.prepare(`
        INSERT INTO anexos (
            entidade_tipo, entidade_id, nome_original, categoria,
            nome_armazenado, tipo_mime, tamanho
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        entidadeTipo,
        entidadeId,
        arquivo.nomeOriginal,
        categoria,
        arquivo.nomeArmazenado,
        arquivo.tipoMime,
        arquivo.tamanho,
    );
}

function exigirPerfil(perfil) {
    return (req, res, next) => {
        if (!req.session.usuario) {
            return res.redirect("/login.html");
        }

        if (req.session.usuario.tipo !== perfil) {
            return res.status(403).send("Acesso não autorizado.");
        }

        next();
    };
}

// ========================================
// PÁGINAS PROTEGIDAS POR PERFIL
// ========================================

app.use(
    "/Gerente",
    exigirPerfil("gerente"),
    express.static(path.join(__dirname, "Gerente"), {
        extensions: ["html"],
    }),
);

app.use(
    "/Usuarios",
    exigirPerfil("funcionario"),
    express.static(path.join(__dirname, "Usuários"), {
        extensions: ["html"],
    }),
);

// ========================================
// PÁGINA INICIAL
// ========================================

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "tcc-main", "site.html"));
});

app.get("/login", (req, res) => {
    res.redirect("/login.html");
});

// ========================================
// ETAPA 1: LOGIN E ENVIO DO CÓDIGO
// ========================================

app.post("/login", async(req, res) => {
    const email = String(req.body.email || "")
        .trim()
        .toLowerCase();

    const senha = String(req.body.senha || "");

    if (!email || !senha || senha.length > 1024) {
        return res.status(400).send("Informe um e-mail e uma senha válidos.");
    }

// Limita novas tentativas para o mesmo IP e e-mail.
const agora = Date.now();
const chaveLogin = `${req.ip}:${email}`;

// Remove bloqueios que já venceram.
for (const [chave, expiracao] of bloqueiosLogin) {
    if (expiracao <= agora) {
        bloqueiosLogin.delete(chave);
    }
}

const bloqueadoAte = bloqueiosLogin.get(chaveLogin);

if (bloqueadoAte && bloqueadoAte > agora) {
    const segundosRestantes = Math.ceil(
        (bloqueadoAte - agora) / 1000
    );

    res.set("Retry-After", String(segundosRestantes));

    return res
        .status(429)
        .send(
            `Você tentou entrar há pouco. Aguarde ${segundosRestantes} segundos antes de tentar novamente.`
        );
}

// Bloqueia uma nova tentativa durante 10 segundos.
bloqueiosLogin.set(
    chaveLogin,
    agora + intervaloLogin
);

    try {
        const usuario = banco
            .prepare(
                `
                SELECT id, nome, email, senha, tipo
                FROM usuarios
                WHERE email = ?
            `,
            )
            .get(email);

        if (!usuario || !verificarSenha(senha, usuario.senha)) {
            return res.status(401).send("E-mail ou senha incorretos.");
        }

        // Atualiza senhas antigas para hash após login válido.
        if (!usuario.senha.startsWith("scrypt$")) {
            banco
                .prepare(
                    `
                    UPDATE usuarios
                    SET senha = ?
                    WHERE id = ?
                `,
                )
                .run(criarHashSenha(senha), usuario.id);
        }

        const codigo = crypto.randomInt(100000, 1000000).toString();

        req.session.usuarioPendente = {
            id: usuario.id,
            nome: usuario.nome,
            email: usuario.email,
            tipo: usuario.tipo,
        };

        req.session.codigoVerificacao = codigo;
        req.session.expiracaoCodigo = Date.now() + 5 * 60 * 1000;
        req.session.tentativasCodigo = 0;

        req.session.save(async(erroSessao) => {
            if (erroSessao) {
                console.error("Erro ao salvar sessão:", erroSessao.message);
                return res.status(500).send("Não foi possível iniciar o login.");
            }

            try {
                await transporter.sendMail({
                    from: `"Bellievie" <${process.env.EMAIL_USER}>`,
                    to: usuario.email,
                    subject: "Código de verificação - Bellievie",
                    text: `Seu código de verificação é ${codigo}. Ele expira em 5 minutos.`,
                    html: `
                        <h2>Bellievie</h2>
                        <p>Seu código de verificação é:</p>
                        <h1>${codigo}</h1>
                        <p>Ele expira em 5 minutos. Se você não tentou entrar,
                        ignore este e-mail.</p>
                    `,
                });

                console.log("Código de verificação enviado para:", usuario.email);
                res.redirect("/verificacao/verify.html");
            } catch (erroEmail) {
                console.error("Erro ao enviar e-mail:", erroEmail.message);

                delete req.session.usuarioPendente;
                delete req.session.codigoVerificacao;
                delete req.session.expiracaoCodigo;
                delete req.session.tentativasCodigo;

                req.session.save(() => {
                    res
                        .status(500)
                        .send(
                            "Não foi possível enviar o código por e-mail. Tente novamente.",
                        );
                });
            }
        });
    } catch (erro) {
        console.error("Erro no login:", erro.message);
        res.status(500).send("Ocorreu um erro ao processar o login.");
    }
});

// ========================================
// ETAPA 2: VALIDAÇÃO DO CÓDIGO
// ========================================

app.post("/verificar-codigo", (req, res) => {
    const codigo = String(req.body.codigo || "");

    if (!/^\d{6}$/.test(codigo)) {
        return res.status(400).send("Digite um código de seis números.");
    }

    const pendente = req.session.usuarioPendente;
    const codigoCorreto = req.session.codigoVerificacao;
    const expiracao = req.session.expiracaoCodigo;

    if (!pendente || !codigoCorreto || !expiracao) {
        return res
            .status(400)
            .send("Nenhuma verificação pendente. Faça o login novamente.");
    }

    if (Date.now() > expiracao) {
        delete req.session.usuarioPendente;
        delete req.session.codigoVerificacao;
        delete req.session.expiracaoCodigo;
        delete req.session.tentativasCodigo;

        return req.session.save(() => {
            res.status(400).send("O código expirou. Faça o login novamente.");
        });
    }

    req.session.tentativasCodigo = (req.session.tentativasCodigo || 0) + 1;

    if (req.session.tentativasCodigo > 5) {
        delete req.session.usuarioPendente;
        delete req.session.codigoVerificacao;
        delete req.session.expiracaoCodigo;
        delete req.session.tentativasCodigo;

        return req.session.save(() => {
            res
                .status(429)
                .send("Limite de tentativas atingido. Faça o login novamente.");
        });
    }

    if (codigo !== codigoCorreto) {
        return req.session.save(() => {
            res.status(400).send("Código incorreto. Tente novamente.");
        });
    }

    const usuario = req.session.usuarioPendente;

    // Renova o identificador da sessão após autenticar.
    req.session.regenerate((erro) => {
        if (erro) {
            console.error("Erro ao renovar sessão:", erro.message);
            return res.status(500).send("Não foi possível concluir o login.");
        }

        req.session.usuario = usuario;

        req.session.save((erroSalvar) => {
            if (erroSalvar) {
                console.error("Erro ao salvar autenticação:", erroSalvar.message);
                return res.status(500).send("Não foi possível concluir o login.");
            }

            if (usuario.tipo === "gerente") {
                return res.redirect("/Gerente/Dashboard.html");
            }

            return res.redirect("/Usuarios/dashboarda.html");
        });
    });
});

// ========================================
// EVENTOS — CONSULTA E SOLICITAÇÃO
// ========================================

app.get("/api/eventos", exigirLoginApi, (req, res) => {
    try {
        const usuario = req.session.usuario;
        const eventos = usuario.tipo === "gerente" ?
            banco.prepare(`
                SELECT e.*, u.nome AS responsavel
                FROM eventos e
                JOIN usuarios u ON u.id = e.usuario_id
                ORDER BY e.data_evento, e.horario, e.id
            `).all() :
            banco.prepare(`
                SELECT e.*, u.nome AS responsavel
                FROM eventos e
                JOIN usuarios u ON u.id = e.usuario_id
                WHERE e.usuario_id = ?
                ORDER BY e.data_evento, e.horario, e.id
            `).all(usuario.id);

        return res.json(eventos);
    } catch (erro) {
        console.error("Erro ao listar eventos:", erro.message);
        return res.status(500).json({
            erro: "Não foi possível consultar os eventos.",
        });
    }
});

app.post("/api/eventos", exigirLoginApi, (req, res) => {
    try {
        const usuario = req.session.usuario;

        if (usuario.tipo !== "funcionario") {
            return res.status(403).json({
                erro: "Somente funcionários podem solicitar eventos.",
            });
        }

        const titulo = typeof req.body.titulo === "string" ? req.body.titulo.trim() : "";
        const dataEvento = typeof req.body.data_evento === "string" ? req.body.data_evento.trim() : "";
        const horario = typeof req.body.horario === "string" ? req.body.horario.trim() : "";
        const local = typeof req.body.local === "string" ? req.body.local.trim() : "";
        const descricao = typeof req.body.descricao === "string" ? req.body.descricao.trim() : "";

        const partesData = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dataEvento);
        const dataValida = partesData && (() => {
            const ano = Number(partesData[1]);
            const mes = Number(partesData[2]);
            const dia = Number(partesData[3]);
            const data = new Date(Date.UTC(ano, mes - 1, dia));
            return data.getUTCFullYear() === ano &&
                data.getUTCMonth() === mes - 1 &&
                data.getUTCDate() === dia;
        })();

        if (!titulo || titulo.length > 150 || !dataValida || !local || local.length > 200) {
            return res.status(400).json({
                erro: "Informe um título, uma data válida e um local. Confira também os limites de caracteres.",
            });
        }

        if (horario && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(horario)) {
            return res.status(400).json({
                erro: "Informe um horário válido.",
            });
        }

        if (descricao.length > 2000) {
            return res.status(400).json({
                erro: "A descrição deve ter no máximo 2.000 caracteres.",
            });
        }

        const resultado = banco.prepare(`
            INSERT INTO eventos (titulo, data_evento, horario, local, descricao, usuario_id)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(titulo, dataEvento, horario || null, local, descricao || null, usuario.id);

        return res.status(201).json({
            mensagem: "Solicitação de evento enviada com sucesso.",
            id: resultado.lastInsertRowid,
        });
    } catch (erro) {
        console.error("Erro ao solicitar evento:", erro.message);
        return res.status(500).json({
            erro: "Não foi possível enviar a solicitação de evento.",
        });
    }
});

// ========================================
// EVENTOS — DECISÃO DO GERENTE
// ========================================

app.patch("/api/eventos/:id/decisao", exigirGerenteApi, (req, res) => {
    try {
        const id = Number(req.params.id);
        const decisao = req.body.decisao;
        const justificativa = typeof req.body.justificativa === "string" ?
            req.body.justificativa.trim() : "";

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ erro: "ID de evento inválido." });
        }

        if (!['aprovado', 'reprovado'].includes(decisao)) {
            return res.status(400).json({
                erro: "A decisão deve ser 'aprovado' ou 'reprovado'.",
            });
        }

        if (decisao === "reprovado" && !justificativa) {
            return res.status(400).json({
                erro: "Informe a justificativa para reprovar o evento.",
            });
        }

        if (justificativa.length > 2000) {
            return res.status(400).json({
                erro: "A justificativa deve ter no máximo 2.000 caracteres.",
            });
        }

        const evento = banco.prepare("SELECT id, status_aprovacao FROM eventos WHERE id = ?").get(id);

        if (!evento) {
            return res.status(404).json({ erro: "Evento não encontrado." });
        }

        if (evento.status_aprovacao !== "pendente") {
            return res.status(409).json({
                erro: "Este evento já foi decidido e não pode ser alterado novamente.",
            });
        }

        const resultado = banco.prepare(`
            UPDATE eventos
            SET status_aprovacao = ?, justificativa = ?, atualizado_em = datetime('now', 'localtime')
            WHERE id = ? AND status_aprovacao = 'pendente'
        `).run(decisao, justificativa || null, id);

        if (resultado.changes === 0) {
            return res.status(409).json({
                erro: "Este evento já foi decidido por outro acesso.",
            });
        }

        return res.json({
            mensagem: decisao === "aprovado" ?
                "Evento aprovado com sucesso." :
                "Evento reprovado com sucesso.",
        });
    } catch (erro) {
        console.error("Erro ao decidir evento:", erro.message);
        return res.status(500).json({
            erro: "Não foi possível registrar a decisão do evento.",
        });
    }
});

// ========================================
// VIAGENS — CONSULTA E SOLICITAÇÃO
// ========================================

app.get("/api/viagens", exigirLoginApi, (req, res) => {
    try {
        const usuario = req.session.usuario;
        const consultaBase = `
            SELECT v.*, u.nome AS responsavel,
                (SELECT a.id FROM anexos a
                 WHERE a.entidade_tipo = 'viagem' AND a.entidade_id = v.id
                 ORDER BY a.id LIMIT 1) AS comprovante_id,
                (SELECT a.nome_original FROM anexos a
                 WHERE a.entidade_tipo = 'viagem' AND a.entidade_id = v.id
                 ORDER BY a.id LIMIT 1) AS comprovante_nome,
                (v.custo_passagem + v.custo_hospedagem + v.custo_transporte_local) AS custo_total
            FROM viagens v
            JOIN usuarios u ON u.id = v.usuario_id
        `;
        const viagens = usuario.tipo === "gerente" ?
            banco.prepare(`${consultaBase} ORDER BY v.data_ida DESC, v.id DESC`).all() :
            banco.prepare(`${consultaBase} WHERE v.usuario_id = ? ORDER BY v.data_ida DESC, v.id DESC`).all(usuario.id);

        return res.json(viagens);
    } catch (erro) {
        console.error("Erro ao listar viagens:", erro.message);
        return res.status(500).json({ erro: "Não foi possível consultar as viagens." });
    }
});

app.post("/api/viagens", exigirLoginApi, (req, res) => {
    let arquivoSalvo = null;
    try {
        const usuario = req.session.usuario;
        if (usuario.tipo !== "funcionario") {
            return res.status(403).json({ erro: "Somente funcionários podem solicitar viagens." });
        }

        const origem = typeof req.body.origem === "string" ? req.body.origem.trim() : "";
        const destino = typeof req.body.destino === "string" ? req.body.destino.trim() : "";
        const dataIda = typeof req.body.data_ida === "string" ? req.body.data_ida.trim() : "";
        const dataVolta = typeof req.body.data_volta === "string" ? req.body.data_volta.trim() : "";
        const transporte = typeof req.body.transporte === "string" ? req.body.transporte.trim() : "";
        const hospedagem = typeof req.body.hospedagem === "string" ? req.body.hospedagem.trim() : "Não";
        const motivo = typeof req.body.motivo === "string" ? req.body.motivo.trim() : "";
        const observacoes = typeof req.body.observacoes === "string" ? req.body.observacoes.trim() : "";

        const custoPassagem = valorMonetarioValido(req.body.custo_passagem);
        const custoHospedagem = valorMonetarioValido(req.body.custo_hospedagem);
        const custoTransporteLocal = valorMonetarioValido(req.body.custo_transporte_local);
        const transportesPermitidos = ["Aéreo", "Rodoviário", "Carro próprio", "Carro alugado"];

        if (!origem || origem.length > 150 || !destino || destino.length > 150 ||
            !dataISOValida(dataIda) || (dataVolta && !dataISOValida(dataVolta)) ||
            (dataVolta && dataVolta < dataIda) || !transportesPermitidos.includes(transporte) ||
            !["Sim", "Não"].includes(hospedagem) || !motivo || motivo.length > 1000 ||
            observacoes.length > 2000 || custoPassagem === null ||
            custoHospedagem === null || custoTransporteLocal === null) {
            return res.status(400).json({
                erro: "Confira origem, destino, período, transporte, motivo e valores informados. A volta não pode ser anterior à ida.",
            });
        }

        if (req.body.comprovante) {
            arquivoSalvo = prepararArquivoUpload(req.body.comprovante);
        }

        const criarViagem = banco.transaction(() => {
            const resultado = banco.prepare(`
                INSERT INTO viagens (
                    origem, destino, data_ida, data_volta, transporte, hospedagem,
                    motivo, observacoes, custo_passagem, custo_hospedagem,
                    custo_transporte_local, usuario_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                origem, destino, dataIda, dataVolta || null, transporte, hospedagem,
                motivo, observacoes || null, custoPassagem, custoHospedagem,
                custoTransporteLocal, usuario.id,
            );

            if (arquivoSalvo) registrarAnexo("viagem", resultado.lastInsertRowid, arquivoSalvo, "comprovante");
            return resultado.lastInsertRowid;
        });

        const id = criarViagem();
        return res.status(201).json({
            mensagem: "Solicitação de viagem enviada com sucesso.",
            id,
        });
    } catch (erro) {
        if (arquivoSalvo) removerArquivosUpload([arquivoSalvo]);
        const status = /arquivo|5 MB|PDF|JPG|PNG|WEBP|conteúdo/i.test(erro.message) ? 400 : 500;
        console.error("Erro ao solicitar viagem:", erro.message);
        return res.status(status).json({
            erro: status === 400 ? erro.message : "Não foi possível enviar a solicitação de viagem.",
        });
    }
});

// ========================================
// VIAGENS — DECISÃO DO GERENTE
// ========================================

app.patch("/api/viagens/:id/decisao", exigirGerenteApi, (req, res) => {
    try {
        const id = Number(req.params.id);
        const decisao = req.body.decisao;
        const justificativa = typeof req.body.justificativa === "string" ? req.body.justificativa.trim() : "";

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ erro: "ID de viagem inválido." });
        }
        if (!["aprovada", "recusada"].includes(decisao)) {
            return res.status(400).json({ erro: "A decisão deve ser 'aprovada' ou 'recusada'." });
        }
        if (decisao === "recusada" && !justificativa) {
            return res.status(400).json({ erro: "Informe a justificativa para recusar a viagem." });
        }
        if (justificativa.length > 2000) {
            return res.status(400).json({ erro: "A justificativa deve ter no máximo 2.000 caracteres." });
        }

        const viagem = banco.prepare("SELECT id, status FROM viagens WHERE id = ?").get(id);
        if (!viagem) return res.status(404).json({ erro: "Solicitação de viagem não encontrada." });
        if (viagem.status !== "pendente") {
            return res.status(409).json({ erro: "Esta solicitação já foi decidida." });
        }

        const resultado = banco.prepare(`
            UPDATE viagens
            SET status = ?, justificativa = ?, atualizado_em = datetime('now', 'localtime')
            WHERE id = ? AND status = 'pendente'
        `).run(decisao, justificativa || null, id);

        if (resultado.changes === 0) {
            return res.status(409).json({ erro: "Esta solicitação já foi decidida por outro acesso." });
        }

        return res.json({
            mensagem: decisao === "aprovada" ? "Viagem aprovada com sucesso." : "Viagem recusada com sucesso.",
        });
    } catch (erro) {
        console.error("Erro ao decidir viagem:", erro.message);
        return res.status(500).json({ erro: "Não foi possível registrar a decisão da viagem." });
    }
});

// ========================================
// USUÁRIO ATUAL — IDENTIFICAÇÃO DA SESSÃO
// ========================================

app.get("/api/usuario-atual", exigirLoginApi, (req, res) => {
    const usuario = req.session.usuario;
    return res.json({ id: usuario.id, nome: usuario.nome, tipo: usuario.tipo });
});

// ========================================
// RELATÓRIOS — CONSULTA E ENVIO
// ========================================

app.get("/api/relatorios", exigirLoginApi, (req, res) => {
    try {
        const usuario = req.session.usuario;
        const relatorios = usuario.tipo === "gerente" ?
            banco.prepare(`
                SELECT r.*, u.nome AS responsavel
                FROM relatorios r
                JOIN usuarios u ON u.id = r.usuario_id
                ORDER BY r.data_relatorio DESC, r.id DESC
            `).all() :
            banco.prepare(`
                SELECT r.*, u.nome AS responsavel
                FROM relatorios r
                JOIN usuarios u ON u.id = r.usuario_id
                WHERE r.usuario_id = ?
                ORDER BY r.data_relatorio DESC, r.id DESC
            `).all(usuario.id);

        const buscarAnexos = banco.prepare(`
            SELECT id, nome_original, categoria, tipo_mime, tamanho
            FROM anexos
            WHERE entidade_tipo = 'relatorio' AND entidade_id = ?
            ORDER BY id
        `);

        return res.json(relatorios.map((relatorio) => ({
            ...relatorio,
            anexos: buscarAnexos.all(relatorio.id),
        })));
    } catch (erro) {
        console.error("Erro ao listar relatórios:", erro.message);
        return res.status(500).json({ erro: "Não foi possível consultar os relatórios." });
    }
});

app.post("/api/relatorios", exigirLoginApi, (req, res) => {
    const arquivosSalvos = [];
    try {
        const usuario = req.session.usuario;
        if (usuario.tipo !== "funcionario") {
            return res.status(403).json({ erro: "Somente funcionários podem enviar relatórios." });
        }

        const nomeEvento = typeof req.body.nome_evento === "string" ? req.body.nome_evento.trim() : "";
        const dataRelatorio = typeof req.body.data_relatorio === "string" ? req.body.data_relatorio.trim() : "";
        const eventoRelacionado = typeof req.body.evento_relacionado === "string" ? req.body.evento_relacionado.trim() : "";
        const resumo = typeof req.body.resumo === "string" ? req.body.resumo.trim() : "";
        const acaoResultado = typeof req.body.acao_resultado === "string" ? req.body.acao_resultado.trim() : "";
        const gastos = valorMonetarioValido(req.body.gastos);
        const contatos = req.body.contatos === undefined || req.body.contatos === "" ? 0 : Number(req.body.contatos);

        if (!nomeEvento || nomeEvento.length > 150 || !dataISOValida(dataRelatorio) ||
            eventoRelacionado.length > 150 || !resumo || resumo.length > 4000 ||
            acaoResultado.length > 5000 || gastos === null ||
            !Number.isInteger(contatos) || contatos < 0 || contatos > 1000000) {
            return res.status(400).json({ erro: "Confira os campos do relatório e os valores informados." });
        }

        const arquivos = Array.isArray(req.body.anexos) ? req.body.anexos : [];
        if (arquivos.length > 5) {
            return res.status(400).json({ erro: "Envie no máximo 5 arquivos por relatório." });
        }

        let tamanhoTotal = 0;
        for (const item of arquivos) {
            if (!item || !["foto", "anexo"].includes(item.categoria)) {
                throw new Error("Categoria de anexo inválida.");
            }
            const arquivo = prepararArquivoUpload(item);
            if (!arquivo) continue;
            tamanhoTotal += arquivo.tamanho;
            if (tamanhoTotal > 10 * 1024 * 1024) {
                removerArquivosUpload([...arquivosSalvos, arquivo]);
                arquivosSalvos.length = 0;
                throw new Error("O tamanho total dos anexos deve ser de no máximo 10 MB.");
            }
            arquivo.categoria = item.categoria;
            arquivosSalvos.push(arquivo);
        }

        const criarRelatorio = banco.transaction(() => {
            const resultado = banco.prepare(`
                INSERT INTO relatorios (
                    nome_evento, data_relatorio, evento_relacionado, resumo,
                    gastos, contatos, acao_resultado, usuario_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                nomeEvento, dataRelatorio, eventoRelacionado || null, resumo,
                gastos, contatos, acaoResultado || null, usuario.id,
            );

            for (const arquivo of arquivosSalvos) {
                registrarAnexo("relatorio", resultado.lastInsertRowid, arquivo, arquivo.categoria);
            }
            return resultado.lastInsertRowid;
        });

        const id = criarRelatorio();
        return res.status(201).json({ mensagem: "Relatório enviado com sucesso.", id });
    } catch (erro) {
        removerArquivosUpload(arquivosSalvos);
        const status = /arquivo|5 MB|10 MB|PDF|JPG|PNG|WEBP|categoria/i.test(erro.message) ? 400 : 500;
        console.error("Erro ao enviar relatório:", erro.message);
        return res.status(status).json({
            erro: status === 400 ? erro.message : "Não foi possível enviar o relatório.",
        });
    }
});

// ========================================
// ANEXOS — ACESSO CONTROLADO
// ========================================

app.get("/api/anexos/:id", exigirLoginApi, (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(404).json({ erro: "Anexo não encontrado." });
        }

        const anexo = banco.prepare("SELECT * FROM anexos WHERE id = ?").get(id);
        if (!anexo) return res.status(404).json({ erro: "Anexo não encontrado." });

        const tabela = anexo.entidade_tipo === "viagem" ? "viagens" : "relatorios";
        const registro = banco.prepare(`SELECT usuario_id FROM ${tabela} WHERE id = ?`).get(anexo.entidade_id);
        if (!registro || (req.session.usuario.tipo !== "gerente" && registro.usuario_id !== req.session.usuario.id)) {
            return res.status(404).json({ erro: "Anexo não encontrado." });
        }

        const caminho = path.join(diretorioUploads, anexo.nome_armazenado);
        if (!fs.existsSync(caminho)) return res.status(404).json({ erro: "Arquivo não encontrado no armazenamento." });

        res.setHeader("Content-Type", anexo.tipo_mime);
        res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(anexo.nome_original)}`);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "private, no-store");
        return res.sendFile(caminho);
    } catch (erro) {
        console.error("Erro ao abrir anexo:", erro.message);
        return res.status(500).json({ erro: "Não foi possível abrir o anexo." });
    }
});

// ========================================
// EQUIPE — LISTAGEM ADMINISTRATIVA
// ========================================

app.get("/api/equipe", exigirGerenteApi, (req, res) => {
    try {
        const representantes = banco.prepare(`
            SELECT id, nome, email
            FROM usuarios
            WHERE tipo = 'funcionario'
            ORDER BY nome COLLATE NOCASE
        `).all();
        return res.json({ total: representantes.length, representantes });
    } catch (erro) {
        console.error("Erro ao consultar equipe:", erro.message);
        return res.status(500).json({ erro: "Não foi possível consultar a equipe." });
    }
});

// ========================================
// GASTOS — ESTIMATIVAS E VALORES INFORMADOS
// ========================================

app.get("/api/gastos", exigirGerenteApi, (req, res) => {
    try {
        const registros = banco.prepare(`
            SELECT
                'viagem' AS tipo,
                v.data_ida AS data,
                v.origem || ' → ' || v.destino AS descricao,
                u.nome AS responsavel,
                (v.custo_passagem + v.custo_hospedagem + v.custo_transporte_local) AS valor,
                v.status AS status
            FROM viagens v
            JOIN usuarios u ON u.id = v.usuario_id
            UNION ALL
            SELECT
                'relatorio' AS tipo,
                r.data_relatorio AS data,
                r.nome_evento AS descricao,
                u.nome AS responsavel,
                r.gastos AS valor,
                'informado' AS status
            FROM relatorios r
            JOIN usuarios u ON u.id = r.usuario_id
            ORDER BY data DESC
        `).all();
        return res.json(registros);
    } catch (erro) {
        console.error("Erro ao consultar gastos:", erro.message);
        return res.status(500).json({ erro: "Não foi possível consultar os gastos registrados." });
    }
});

// ========================================
// CALENDÁRIO — EVENTOS, VISITAS E VIAGENS
// ========================================

app.get("/api/calendario", exigirLoginApi, (req, res) => {
    try {
        const usuario = req.session.usuario;
        const filtro = usuario.tipo === "gerente" ? "" : " WHERE usuario_id = ?";
        const parametros = usuario.tipo === "gerente" ? [] : [usuario.id];

        const eventos = banco.prepare(`
            SELECT id, titulo, data_evento AS data, horario, local, status_aprovacao AS status,
                   usuario_id, 'evento' AS tipo
            FROM eventos${filtro}
        `).all(...parametros);
        const visitas = banco.prepare(`
            SELECT id, titulo, data_visita AS data, horario, endereco AS local, status,
                   usuario_id, 'visita' AS tipo
            FROM visitas${filtro ? `${filtro} AND status <> 'cancelada'` : " WHERE status <> 'cancelada'"}
        `).all(...parametros);
        const viagens = banco.prepare(`
            SELECT id, origem || ' → ' || destino AS titulo, data_ida AS data,
                   NULL AS horario, destino AS local, status, usuario_id, 'viagem' AS tipo
            FROM viagens${filtro}
        `).all(...parametros);

        const itens = [...eventos, ...visitas, ...viagens]
            .sort((a, b) => String(a.data).localeCompare(String(b.data)) || String(a.horario || "").localeCompare(String(b.horario || "")));
        return res.json(itens);
    } catch (erro) {
        console.error("Erro ao montar calendário:", erro.message);
        return res.status(500).json({ erro: "Não foi possível consultar o calendário." });
    }
});

// ========================================
// VISITAS: LISTAGEM
// Gerente vê todas; funcionário vê apenas as próprias
// ========================================

app.get("/api/visitas", exigirLoginApi, (req, res) => {
    try {
        const usuario = req.session.usuario;
        let visitas;

        if (usuario.tipo === "gerente") {
            visitas = banco
                .prepare(
                    `
                    SELECT v.*, u.nome AS responsavel
                    FROM visitas v
                    JOIN usuarios u ON u.id = v.usuario_id
                    ORDER BY v.data_visita, v.horario
                `,
                )
                .all();
        } else {
            visitas = banco
                .prepare(
                    `
                    SELECT v.*, u.nome AS responsavel
                    FROM visitas v
                    JOIN usuarios u ON u.id = v.usuario_id
                    WHERE v.usuario_id = ?
                    ORDER BY v.data_visita, v.horario
                `,
                )
                .all(usuario.id);
        }

        res.json(visitas);
    } catch (erro) {
        console.error("Erro ao listar visitas:", erro.message);
        res.status(500).json({
            erro: "Não foi possível listar as visitas.",
        });
    }
});

// ========================================
// CADASTRO DE VISITA
// ========================================

app.post("/api/visitas", exigirLoginApi, (req, res) => {
    try {
        const {
            titulo,
            data_visita,
            horario,
            endereco,
            nome_contato,
            empresa,
            telefone,
            finalidade,
            observacoes,
        } = req.body;

        const obrigatorios = [
            titulo,
            data_visita,
            horario,
            endereco,
            nome_contato,
            empresa,
            finalidade,
        ];

        if (
            obrigatorios.some((valor) => typeof valor !== "string" || !valor.trim())
        ) {
            return res.status(400).json({
                erro: "Preencha todos os campos obrigatórios.",
            });
        }

        const resultado = banco
            .prepare(
                `
                INSERT INTO visitas (
                    titulo,
                    data_visita,
                    horario,
                    endereco,
                    nome_contato,
                    empresa,
                    telefone,
                    finalidade,
                    observacoes,
                    usuario_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            )
            .run(
                titulo.trim(),
                data_visita,
                horario,
                endereco.trim(),
                nome_contato.trim(),
                empresa.trim(),
                telefone || null,
                finalidade.trim(),
                observacoes || null,
                req.session.usuario.id,
            );

        res.status(201).json({
            mensagem: "Visita cadastrada com sucesso.",
            id: resultado.lastInsertRowid,
        });
    } catch (erro) {
        console.error("Erro ao cadastrar visita:", erro.message);
        res.status(500).json({
            erro: "Não foi possível cadastrar a visita.",
        });
    }
});

// ========================================
// DETALHES DE UMA VISITA
// ========================================

app.get("/api/visitas/:id", exigirLoginApi, (req, res) => {
    try {
        const usuario = req.session.usuario;
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                erro: "ID inválido.",
            });
        }

        let visita;

        if (usuario.tipo === "gerente") {
            visita = banco
                .prepare(
                    `
                    SELECT v.*, u.nome AS responsavel
                    FROM visitas v
                    JOIN usuarios u ON u.id = v.usuario_id
                    WHERE v.id = ?
                `,
                )
                .get(id);
        } else {
            visita = banco
                .prepare(
                    `
                    SELECT v.*, u.nome AS responsavel
                    FROM visitas v
                    JOIN usuarios u ON u.id = v.usuario_id
                    WHERE v.id = ? AND v.usuario_id = ?
                `,
                )
                .get(id, usuario.id);
        }

        if (!visita) {
            return res.status(404).json({
                erro: "Visita não encontrada ou sem permissão de acesso.",
            });
        }

        res.json(visita);
    } catch (erro) {
        console.error("Erro ao consultar visita:", erro.message);
        res.status(500).json({
            erro: "Não foi possível consultar a visita.",
        });
    }
});

// ========================================
// EDIÇÃO DE VISITA
// ========================================

app.put("/api/visitas/:id", exigirLoginApi, (req, res) => {
    try {
        const usuario = req.session.usuario;
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                erro: "ID inválido.",
            });
        }

        const visita = banco.prepare("SELECT * FROM visitas WHERE id = ?").get(id);

        if (!visita) {
            return res.status(404).json({
                erro: "Visita não encontrada.",
            });
        }

        if (usuario.tipo !== "gerente" && visita.usuario_id !== usuario.id) {
            return res.status(403).json({
                erro: "Você não pode editar esta visita.",
            });
        }

        const campos = [
            "titulo",
            "data_visita",
            "horario",
            "endereco",
            "nome_contato",
            "empresa",
            "finalidade",
        ];

        if (
            campos.some(
                (campo) =>
                typeof req.body[campo] !== "string" || !req.body[campo].trim(),
            )
        ) {
            return res.status(400).json({
                erro: "Preencha todos os campos obrigatórios.",
            });
        }

        banco
            .prepare(
                `
                UPDATE visitas SET
                    titulo = ?,
                    data_visita = ?,
                    horario = ?,
                    endereco = ?,
                    nome_contato = ?,
                    empresa = ?,
                    telefone = ?,
                    finalidade = ?,
                    observacoes = ?,
                    atualizada_em = CURRENT_TIMESTAMP
                WHERE id = ?
            `,
            )
            .run(
                req.body.titulo.trim(),
                req.body.data_visita,
                req.body.horario,
                req.body.endereco.trim(),
                req.body.nome_contato.trim(),
                req.body.empresa.trim(),
                req.body.telefone || null,
                req.body.finalidade.trim(),
                req.body.observacoes || null,
                id,
            );

        res.json({
            mensagem: "Visita atualizada com sucesso.",
        });
    } catch (erro) {
        console.error("Erro ao editar visita:", erro.message);
        res.status(500).json({
            erro: "Não foi possível editar a visita.",
        });
    }
});

// ========================================
// CANCELAMENTO DE VISITA
// ========================================

app.patch("/api/visitas/:id/cancelar", exigirLoginApi, (req, res) => {
    try {
        const usuario = req.session.usuario;
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                erro: "ID inválido.",
            });
        }

        let resultado;

        if (usuario.tipo === "gerente") {
            resultado = banco
                .prepare(
                    `
                    UPDATE visitas
                    SET status = 'cancelada',
                        atualizada_em = CURRENT_TIMESTAMP
                    WHERE id = ?
                `,
                )
                .run(id);
        } else {
            resultado = banco
                .prepare(
                    `
                    UPDATE visitas
                    SET status = 'cancelada',
                        atualizada_em = CURRENT_TIMESTAMP
                    WHERE id = ? AND usuario_id = ?
                `,
                )
                .run(id, usuario.id);
        }

        if (resultado.changes === 0) {
            return res.status(404).json({
                erro: "Visita não encontrada ou sem permissão de acesso.",
            });
        }

        res.json({
            mensagem: "Visita cancelada com sucesso.",
        });
    } catch (erro) {
        console.error("Erro ao cancelar visita:", erro.message);
        res.status(500).json({
            erro: "Não foi possível cancelar a visita.",
        });
    }
});

// ========================================
// EXCLUSÃO DE VISITA
// ========================================

app.delete("/api/visitas/:id", exigirLoginApi, (req, res) => {
    try {
        const usuario = req.session.usuario;
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                erro: "ID inválido.",
            });
        }

        const resultado = usuario.tipo === "gerente" ?
            banco.prepare("DELETE FROM visitas WHERE id = ?").run(id) :
            banco.prepare("DELETE FROM visitas WHERE id = ? AND usuario_id = ?")
                .run(id, usuario.id);

        if (resultado.changes === 0) {
            return res.status(404).json({
                erro: "Visita não encontrada ou sem permissão de acesso.",
            });
        }

        return res.json({
            mensagem: "Visita excluída com sucesso.",
        });
    } catch (erro) {
        console.error("Erro ao excluir visita:", erro.message);
        return res.status(500).json({
            erro: "Não foi possível excluir a visita.",
        });
    }
});

// ========================================
// LOGOUT
// ========================================

app.get("/sair", exigirLogin, (req, res) => {
    req.session.destroy((erro) => {
        if (erro) {
            console.error("Erro ao encerrar sessão:", erro.message);

            return res.status(500).send("Não foi possível encerrar a sessão.");
        }

        res.clearCookie("bellievie.sid");
        res.redirect("/");
    });
});

// ========================================
// INICIALIZAÇÃO DO SERVIDOR
// ========================================

app.listen(PORT, () => {
    console.log(`Servidor Bellievie rodando em http://localhost:${PORT}`);
});