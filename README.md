# Bolão da Copa do Mundo

Bem-vindo ao **Bolão WC**! Um aplicativo web interativo para criar e gerenciar bolões da Copa do Mundo.

## Descrição

Este projeto é um bolão para a Copa do Mundo, permitindo que usuários façam previsões sobre os resultados das partidas e acompanhem suas pontuações em tempo real.

## Tecnologias Utilizadas

- **HTML** - 50.4% (Interface do usuário)
- **Python** - 39.4% (Backend e lógica da aplicação)
- **PL/pgSQL** - 10.2% (Banco de dados)

## Funcionalidades

- Interface web responsiva
- Sistema de previsões de resultados
- Cálculo automático de pontuações
- Ranking de participantes
- Banco de dados PostgreSQL integrado

## Estrutura do Projeto

```pastas
bolao-wc/
├── main.py              # Aplicação principal em Python
├── init.sql             # Scripts de inicialização do banco de dados
├── requirements.txt     # Dependências Python
├── static/              # Arquivos estáticos (CSS, JS, imagens)
├── data/                # Dados da aplicação
└── README.md            # Este arquivo
```

## Instalação

1. Clone o repositório:

```bash
git clone https://github.com/diasgomess/bolao-wc.git
cd bolao-wc
```

1. Instale as dependências:

```bash
pip install -r requirements.txt
```

1. Configure o banco de dados:

```bash
psql -U seu_usuario -d seu_banco < init.sql
```

1. Execute a aplicação:

```bash
python main.py
```

## Como Usar

1. Acesse a aplicação no seu navegador
2. Faça login ou crie uma conta
3. Faça suas previsões para os jogos
4. Acompanhe seu desempenho no ranking

## Contribuindo

Contribuições são bem-vindas! Sinta-se à vontade para:

- Reportar bugs
- Sugerir melhorias
- Fazer um fork e criar um pull request

## Licença

Este projeto é de código aberto e está disponível para uso pessoal e educacional.

## Contato

Para dúvidas ou sugestões, entre em contato através das issues do repositório.

---

**Boa sorte em seu bolão!**
