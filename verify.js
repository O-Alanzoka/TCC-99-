const express = require("express");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(express.static(path.join(__dirname, "..")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "login.html"));
});

app.post("/login", (req, res) => {
    const { email, senha } = req.body;

    console.log("Tentativa de login:");
    console.log("E-mail:", email);

    if (!email || !senha) {
        return res.status(400).send("E-mail e senha são obrigatórios.");
    }

    // aqui entra a geração/envio do código...

    res.send(`
        <!DOCTYPE html>
        <html lang="pt-br">
        <head>
            <meta charset="UTF-8">
            <title>Bellievie</title>
        </head>
        <body>
            <h1>Login recebido!</h1>
            <p>E-mail: ${email}</p>
            <p>O próximo passo será a verificação em duas etapas.</p>
        </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});