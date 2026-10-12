--
-- PostgreSQL database dump
--

-- Dumped from database version 16.4 (Debian 16.4-1.pgdg110+2)
-- Dumped by pg_dump version 16.4 (Debian 16.4-1.pgdg110+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: codedb_export_c8c93cb5e14a; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA codedb_export_c8c93cb5e14a;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: t; Type: TABLE; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

CREATE TABLE codedb_export_c8c93cb5e14a.t (
    id integer NOT NULL,
    parent_id integer,
    n numeric(30,10),
    testo text,
    bin bytea,
    dt timestamp(6) without time zone,
    calcolata integer GENERATED ALWAYS AS ((parent_id + 1)) STORED,
    g point,
    j jsonb,
    numeri numeric[],
    seriale bigint NOT NULL
);


--
-- Name: Seq prova; Type: SEQUENCE; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

CREATE SEQUENCE codedb_export_c8c93cb5e14a."Seq prova"
    START WITH 100
    INCREMENT BY 7
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: Seq prova; Type: SEQUENCE OWNED BY; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

ALTER SEQUENCE codedb_export_c8c93cb5e14a."Seq prova" OWNED BY codedb_export_c8c93cb5e14a.t.seriale;


--
-- Name: mv; Type: MATERIALIZED VIEW; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

CREATE MATERIALIZED VIEW codedb_export_c8c93cb5e14a.mv AS
 SELECT parent_id
   FROM codedb_export_c8c93cb5e14a.t
  WITH NO DATA;


--
-- Name: v_mv; Type: VIEW; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

CREATE VIEW codedb_export_c8c93cb5e14a.v_mv AS
 SELECT parent_id
   FROM codedb_export_c8c93cb5e14a.mv;


--
-- Name: mv_seconda; Type: MATERIALIZED VIEW; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

CREATE MATERIALIZED VIEW codedb_export_c8c93cb5e14a.mv_seconda AS
 SELECT parent_id
   FROM codedb_export_c8c93cb5e14a.v_mv
  WITH NO DATA;


--
-- Name: padre; Type: TABLE; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

CREATE TABLE codedb_export_c8c93cb5e14a.padre (
    id integer NOT NULL
);


--
-- Name: t_id_seq; Type: SEQUENCE; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

ALTER TABLE codedb_export_c8c93cb5e14a.t ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME codedb_export_c8c93cb5e14a.t_id_seq
    START WITH 1
    INCREMENT BY 5
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: v; Type: VIEW; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

CREATE VIEW codedb_export_c8c93cb5e14a.v AS
 SELECT parent_id
   FROM codedb_export_c8c93cb5e14a.t;


--
-- Name: t seriale; Type: DEFAULT; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

ALTER TABLE ONLY codedb_export_c8c93cb5e14a.t ALTER COLUMN seriale SET DEFAULT nextval('codedb_export_c8c93cb5e14a."Seq prova"'::regclass);


--
-- Data for Name: padre; Type: TABLE DATA; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

COPY codedb_export_c8c93cb5e14a.padre (id) FROM stdin;
1
\.


--
-- Data for Name: t; Type: TABLE DATA; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

COPY codedb_export_c8c93cb5e14a.t (id, parent_id, n, testo, bin, dt, g, j, numeri, seriale) FROM stdin;
1	1	12345678901234567890.1234567890	apice ' backslash \\ newline\n emoji 🦊 $&	\\x00ff7f	2026-09-25 12:34:56.123456	(12,41)	{"n": 9007199254740993}	{12345678901234567890.1234567890}	1
\.


--
-- Name: Seq prova; Type: SEQUENCE SET; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

SELECT pg_catalog.setval('codedb_export_c8c93cb5e14a."Seq prova"', 41, false);


--
-- Name: t_id_seq; Type: SEQUENCE SET; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

SELECT pg_catalog.setval('codedb_export_c8c93cb5e14a.t_id_seq', 1, true);


--
-- Name: padre padre_pkey; Type: CONSTRAINT; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

ALTER TABLE ONLY codedb_export_c8c93cb5e14a.padre
    ADD CONSTRAINT padre_pkey PRIMARY KEY (id);


--
-- Name: t t_pkey; Type: CONSTRAINT; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

ALTER TABLE ONLY codedb_export_c8c93cb5e14a.t
    ADD CONSTRAINT t_pkey PRIMARY KEY (id);


--
-- Name: t fk_padre; Type: FK CONSTRAINT; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

ALTER TABLE ONLY codedb_export_c8c93cb5e14a.t
    ADD CONSTRAINT fk_padre FOREIGN KEY (parent_id) REFERENCES codedb_export_c8c93cb5e14a.padre(id);


--
-- Name: mv; Type: MATERIALIZED VIEW DATA; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

REFRESH MATERIALIZED VIEW codedb_export_c8c93cb5e14a.mv;


--
-- Name: mv_seconda; Type: MATERIALIZED VIEW DATA; Schema: codedb_export_c8c93cb5e14a; Owner: -
--

REFRESH MATERIALIZED VIEW codedb_export_c8c93cb5e14a.mv_seconda;


--
-- PostgreSQL database dump complete
--

