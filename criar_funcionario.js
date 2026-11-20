const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const caminhoBanco = process.env.BELIEVIE_DB_PATH
    ? path.resolve(process.env.BELIEVIE_DB_PATH)
    : path.join(__dirname, "tcc-main", "banco.db");
const banco = new Database(caminhoBanco);
banco.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        senha TEXT NOT NULL,
        tipo TEXT NOT NULL DEFAULT 'funcionario'
            CHECK (tipo IN ('gerente', 'funcionario'))
    );
`);

const entradaInterativa = process.stdin.isTTY;
const rl = entradaInterativa ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
const respostasPiped = entradaInterativa ? null : fs.readFileSync(0, "utf8").split(/\r?\n/);
let indiceResposta = 0;

function perguntar(pergunta) {
    if (!entradaInterativa) {
        process.stdout.write(pergunta);
        return Promise.resolve(respostasPiped[indiceResposta++] || "");
    }
    return new Promise((resolve) => rl.question(pergunta, resolve));
}

function gerarHash(senha) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(senha, salt, 64).toString("hex");
    return `scrypt$${salt}$${hash}`;
}

async function main() {
    try {
        const nome = (await perguntar("Nome completo do funcionário: ")).trim();
        const email = (await perguntar("E-mail do funcionário: ")).trim().toLowerCase();
        if (!nome || !/^\S+@\S+\.\S+$/.test(email)) {
            throw new Error("Informe um nome e um e-mail válido.");
        }

        const existente = banco.prepare("SELECT id FROM usuarios WHERE email = ?").get(email);
        if (existente) {
            console.log("Este e-mail já está cadastrado. Nenhuma alteração foi feita.");
            return;
        }

        const senha = await perguntar("Digite uma senha inicial (mínimo 12 caracteres): ");
        if (senha.length < 12) throw new Error("A senha precisa ter pelo menos 12 caracteres.");
        const confirmacao = await perguntar("Confirme a senha: ");
        if (senha !== confirmacao) throw new Error("As senhas não coincidem.");

        banco.prepare(`
            INSERT INTO usuarios (nome, email, senha, tipo)
            VALUES (?, ?, ?, 'funcionario')
        `).run(nome, email, gerarHash(senha));
        console.log("Funcionário cadastrado com sucesso.");
    } catch (erro) {
        console.error("Erro ao cadastrar funcionário:", erro.message);
        process.exitCode = 1;
    } finally {
        banco.close();
        if (rl) rl.close();
    }
}

main();
